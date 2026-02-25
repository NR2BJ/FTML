"""
FTML Whisper Server — OpenVINO GenAI WhisperPipeline
Lightweight FastAPI server wrapping OpenVINO's WhisperPipeline for
Intel Arc GPU-accelerated speech-to-text with timestamp support.

Pipeline:
  Audio → 5-min chunking (VRAM management) → Whisper inference (GPU)
    → hallucination filtering → WebVTT output

Endpoints:
  POST /v1/audio/transcriptions  (OpenAI-compatible)
  POST /v1/model/load            (runtime model swap)
  GET  /v1/model/info            (current model info)
  GET  /health
"""

import asyncio
import gc
import io
import os
import logging
import re
import time
from contextlib import asynccontextmanager

import threading
import numpy as np
import librosa
import uvicorn
from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.responses import PlainTextResponse, JSONResponse
from pydantic import BaseModel

logging.basicConfig(
    level=logging.INFO,
    format="[whisper] %(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("whisper")

DEFAULT_MODEL_ID = "OpenVINO/whisper-large-v3-int8-ov"

# Audio chunking: split long audio into chunks for VRAM management.
# Whisper processes each chunk independently, timestamps are remapped to absolute.
CHUNK_DURATION_S = int(os.environ.get("CHUNK_DURATION_S", "300"))  # 5 minutes
CHUNK_OVERLAP_S = int(os.environ.get("CHUNK_OVERLAP_S", "2"))  # overlap to protect sentence boundaries


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle for FastAPI."""
    mid = os.environ.get("MODEL_ID", DEFAULT_MODEL_ID)
    load_model_by_id(mid)
    if IDLE_TIMEOUT > 0:
        log.info(f"VRAM auto-release enabled: model unloads after {IDLE_TIMEOUT}s idle")
    else:
        log.info("VRAM auto-release disabled (IDLE_TIMEOUT=0)")
    yield


# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------
app = FastAPI(title="FTML Whisper Server", lifespan=lifespan)
pipeline = None
model_id_str = None
model_lock = threading.Lock()
loading_model = False

# VRAM auto-release: unload model after idle timeout to free GPU memory.
# The model is automatically reloaded on the next inference request.
IDLE_TIMEOUT = int(os.environ.get("IDLE_TIMEOUT", "120"))  # seconds (0 = disabled)
_last_inference_time = 0.0
_idle_timer = None
_idle_timer_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Model loading / unloading
# ---------------------------------------------------------------------------

def load_model_by_id(mid: str, is_swap: bool = False):
    """Load a WhisperPipeline for the given HuggingFace model ID.

    Args:
        mid: HuggingFace model ID (e.g. "OpenVINO/whisper-large-v3-int8-ov")
        is_swap: If True, this is a runtime model swap (unload previous first)
    """
    global pipeline, model_id_str, loading_model
    import openvino_genai
    from huggingface_hub import snapshot_download

    device = os.environ.get("DEVICE", "GPU")
    loading_model = True

    # For model swaps, unload the previous model first to free VRAM.
    # Without this, two models may coexist briefly and OOM on small GPUs.
    if is_swap and pipeline is not None:
        log.info(f"Unloading previous model ({model_id_str}) to free VRAM for new model")
        with model_lock:
            pipeline = None
        gc.collect()

    try:
        log.info(f"Loading model: {mid} on device: {device}")
        model_path = snapshot_download(mid)
        log.info(f"Model path: {model_path}")
        new_pipeline = openvino_genai.WhisperPipeline(str(model_path), device)
        with model_lock:
            pipeline = new_pipeline
            model_id_str = mid
        log.info(f"WhisperPipeline loaded successfully on {device}")
    except Exception as e:
        # On failure, ensure pipeline is None so we don't silently use an old model
        with model_lock:
            pipeline = None
            if is_swap:
                # Keep model_id_str as the requested model so reload attempts use it
                model_id_str = mid
        log.error(f"Failed to load model {mid}: {e}")
        raise
    finally:
        loading_model = False


def unload_model():
    """Unload the model from GPU memory to free VRAM."""
    global pipeline
    with model_lock:
        if pipeline is None:
            return
        pipeline = None
    gc.collect()
    log.info("Model unloaded from GPU (VRAM released)")


def ensure_model_loaded():
    """Ensure the model is loaded, reloading if it was unloaded for VRAM release."""
    global pipeline
    if pipeline is not None:
        return
    mid = model_id_str or os.environ.get("MODEL_ID", DEFAULT_MODEL_ID)
    log.info(f"Reloading model for inference: {mid}")
    load_model_by_id(mid)


def _schedule_idle_unload():
    """Schedule model unload after IDLE_TIMEOUT seconds of inactivity."""
    global _idle_timer, _last_inference_time
    if IDLE_TIMEOUT <= 0:
        return

    with _idle_timer_lock:
        if _idle_timer is not None:
            _idle_timer.cancel()
        _last_inference_time = time.time()
        _idle_timer = threading.Timer(IDLE_TIMEOUT, _check_and_unload)
        _idle_timer.daemon = True
        _idle_timer.start()


def _check_and_unload():
    """Check if idle timeout has elapsed and unload model if so."""
    global _idle_timer
    elapsed = time.time() - _last_inference_time
    if elapsed >= IDLE_TIMEOUT - 1:  # 1s tolerance
        log.info(f"Idle for {elapsed:.0f}s (timeout={IDLE_TIMEOUT}s), unloading model to free VRAM")
        unload_model()
    with _idle_timer_lock:
        _idle_timer = None



# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def format_ts(seconds: float) -> str:
    """Format seconds as HH:MM:SS.mmm for VTT."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def chunks_to_vtt(chunks) -> str:
    """Convert WhisperPipeline chunks to WebVTT format with hallucination filtering."""
    lines = ["WEBVTT", ""]
    idx = 1
    prev_text = ""
    repeat_count = 0

    for chunk in chunks:
        text = chunk.text.strip() if hasattr(chunk, 'text') else chunk.get('text', '').strip()
        if not text:
            continue

        start_ts = chunk.start_ts if hasattr(chunk, 'start_ts') else chunk['start_ts']
        end_ts = chunk.end_ts if hasattr(chunk, 'end_ts') else chunk['end_ts']
        duration = end_ts - start_ts

        # Skip chunks spanning an entire 30s window (likely hallucination)
        if duration >= 29.0:
            log.debug(f"Filtered 29s+ chunk: [{format_ts(start_ts)}→{format_ts(end_ts)}] {text[:50]}")
            continue

        # Skip 3+ consecutive identical texts (repetition hallucination)
        if text == prev_text:
            repeat_count += 1
            if repeat_count >= 2:
                continue
        else:
            repeat_count = 0
        prev_text = text

        # Skip known hallucination patterns
        if is_hallucination(text, duration):
            continue

        start = format_ts(start_ts)
        end = format_ts(end_ts)
        lines.append(str(idx))
        lines.append(f"{start} --> {end}")
        lines.append(text)
        lines.append("")
        idx += 1

    return "\n".join(lines)


def decode_audio(audio_bytes: bytes) -> np.ndarray:
    """Decode audio bytes to 16kHz mono float32 numpy array."""
    audio_io = io.BytesIO(audio_bytes)
    audio, _ = librosa.load(audio_io, sr=16000, mono=True)
    return audio.astype(np.float32)


# ---------------------------------------------------------------------------
# Hallucination filtering
# ---------------------------------------------------------------------------

# Known Whisper hallucination phrases (exact match)
_HALLUCINATION_EXACT = {
    # Japanese
    "ご視聴ありがとうございました", "ご視聴ありがとうございます",
    "お疲れ様でした", "おやすみなさい", "では、また", "それでは、また",
    # English
    "thank you for watching", "thanks for watching",
    "please subscribe", "like and subscribe", "see you next time",
    # Korean
    "시청해 주셔서 감사합니다", "구독과 좋아요 부탁드립니다",
    # Chinese
    "谢谢观看", "感谢收看",
    # Generic
    "...", "…",
}

# Regex patterns for hallucination artifacts
_HALLUCINATION_PATTERNS = [
    re.compile(r'^by\s+\w\.?$', re.IGNORECASE),   # "by H.", "by A."
    re.compile(r'^[\.…\s]+$'),                      # dots/ellipsis only
    re.compile(r'^[\s\W]+$'),                        # whitespace/punctuation only
    re.compile(r'^[a-zA-Z]{1,2}$'),                   # 1-2 ASCII chars: "me", "a", "I"
]


def is_hallucination(text: str, duration: float) -> bool:
    """Detect common Whisper hallucination patterns.

    Args:
        text: transcribed text (already stripped)
        duration: chunk duration in seconds
    Returns:
        True if this is likely a hallucination to be discarded
    """
    if not text:
        return True
    t = text.strip()
    if not t:
        return True

    # Exact match against known hallucination phrases
    if t in _HALLUCINATION_EXACT or t.lower() in _HALLUCINATION_EXACT:
        return True

    # Regex pattern match
    for pattern in _HALLUCINATION_PATTERNS:
        if pattern.match(t):
            return True

    # Short text + short duration = noise artifact
    # CJK chars are 3 bytes each in UTF-8, so byte length filters ASCII-only junk
    if len(t.encode('utf-8')) <= 4 and duration < 0.5:
        return True

    # Sub-0.2s is too short for real speech
    if duration < 0.2:
        return True

    return False


# ---------------------------------------------------------------------------
# Inference
# ---------------------------------------------------------------------------

def run_inference(audio: np.ndarray, language: str = ""):
    """Run Whisper inference on audio, with 5-min chunking for VRAM management.

    Short audio (<= CHUNK_DURATION_S) is processed in a single pass.
    Longer audio is split into overlapping chunks, each processed independently,
    with timestamps remapped to absolute positions.
    """
    ensure_model_loaded()

    config = pipeline.get_generation_config()
    config.return_timestamps = True
    config.task = "transcribe"
    if language and language != "auto":
        config.language = f"<|{language}|>"

    # Tune for media with BGM/SFX (anime, movies, etc.)
    config.no_speech_threshold = float(os.environ.get("NO_SPEECH_THRESHOLD", "0.4"))
    config.compression_ratio_threshold = float(os.environ.get("COMPRESSION_RATIO_THRESHOLD", "1.8"))

    sr = 16000
    chunk_samples = CHUNK_DURATION_S * sr
    total_duration = len(audio) / sr

    # Short audio: single pass
    if len(audio) <= chunk_samples:
        log.info(f"Inference: {total_duration:.1f}s, "
                 f"model={model_id_str}, language={language or 'auto'}")

        t0 = time.time()
        result = pipeline.generate(audio, config)
        elapsed = time.time() - t0

        chunks = getattr(result, "chunks", [])
        full_text = "".join(c.text for c in chunks).strip() if chunks else str(result)

        log.info(f"Done: {len(chunks)} chunks, {len(full_text)} chars in {elapsed:.1f}s")

        _schedule_idle_unload()
        return chunks, full_text, elapsed

    # Long audio: chunked processing
    overlap_samples = CHUNK_OVERLAP_S * sr
    num_chunks = 1 + max(0, int(np.ceil((len(audio) - chunk_samples) / (chunk_samples - overlap_samples))))
    log.info(f"Chunked inference: {total_duration:.1f}s → {num_chunks} chunks of {CHUNK_DURATION_S}s, "
             f"model={model_id_str}, language={language or 'auto'}")

    all_chunks = []
    total_elapsed = 0.0
    pos = 0
    chunk_idx = 0

    while pos < len(audio):
        end = min(pos + chunk_samples, len(audio))
        segment = audio[pos:end]
        offset_s = pos / sr
        seg_duration = len(segment) / sr

        t0 = time.time()
        result = pipeline.generate(segment, config)
        elapsed = time.time() - t0
        total_elapsed += elapsed

        chunks = getattr(result, "chunks", [])
        added = 0

        for c in chunks:
            text = c.text.strip()
            if not text:
                continue

            abs_start = c.start_ts + offset_s
            abs_end = c.end_ts + offset_s
            duration = abs_end - abs_start

            if is_hallucination(text, duration):
                continue

            # Deduplicate overlap region
            if all_chunks:
                last = all_chunks[-1]
                if abs_start < last['end_ts']:
                    continue
                # Near-boundary identical text dedup (within 3s)
                if (abs_start - last['end_ts']) < 3.0 and text == last['text']:
                    continue

            all_chunks.append({'text': text, 'start_ts': abs_start, 'end_ts': abs_end})
            added += 1

        log.info(f"  Chunk {chunk_idx + 1}/{num_chunks} "
                 f"[{offset_s:.0f}s-{offset_s + seg_duration:.0f}s] "
                 f"({elapsed:.1f}s): {added} cues")

        # Advance position: subtract overlap unless this is the last chunk
        if end < len(audio):
            pos = end - overlap_samples
        else:
            break
        chunk_idx += 1

    full_text = " ".join(c['text'] for c in all_chunks)
    log.info(f"Done: {len(all_chunks)} chunks, {len(full_text)} chars in {total_elapsed:.1f}s")

    _schedule_idle_unload()
    return all_chunks, full_text, total_elapsed


# ---------------------------------------------------------------------------
# OpenAI-compatible endpoint
# ---------------------------------------------------------------------------

@app.post("/v1/audio/transcriptions")
async def transcribe_openai(
    file: UploadFile = File(...),
    language: str = Form(default=""),
    response_format: str = Form(default="vtt"),
):
    if loading_model:
        raise HTTPException(503, "Model is loading, please wait")

    audio_bytes = await file.read()
    log.info(f"Received: {file.filename} ({len(audio_bytes)} bytes)")

    try:
        audio = decode_audio(audio_bytes)
    except Exception as e:
        log.error(f"Audio decode failed: {e}")
        raise HTTPException(400, f"Failed to decode audio: {e}")

    log.info(f"Audio: {len(audio)/16000:.1f}s, {len(audio)} samples")

    try:
        loop = asyncio.get_event_loop()
        chunks, full_text, elapsed = await loop.run_in_executor(
            None, run_inference, audio, language
        )
    except Exception as e:
        log.error(f"Inference failed: {e}")
        raise HTTPException(500, f"Inference failed: {e}")

    log.info(f"Done: {len(chunks)} chunks, {len(full_text)} chars in {elapsed:.1f}s")

    if response_format == "vtt":
        vtt = chunks_to_vtt(chunks) if chunks else f"WEBVTT\n\n1\n00:00:00.000 --> 99:59:59.999\n{full_text}\n"
        return PlainTextResponse(vtt, media_type="text/vtt")
    elif response_format == "verbose_json":
        if chunks:
            segments = []
            for c in chunks:
                if hasattr(c, 'start_ts'):
                    segments.append({"start": c.start_ts, "end": c.end_ts, "text": c.text.strip()})
                else:
                    segments.append({"start": c['start_ts'], "end": c['end_ts'], "text": c['text'].strip()})
        else:
            segments = []
        return JSONResponse({"text": full_text, "language": language or "auto", "duration": len(audio) / 16000, "segments": segments})
    else:
        return JSONResponse({"text": full_text})


# ---------------------------------------------------------------------------
# Model management
# ---------------------------------------------------------------------------

class ModelLoadRequest(BaseModel):
    model_id: str

@app.post("/v1/model/load")
async def load_new_model(req: ModelLoadRequest):
    """Load a new model at runtime (downloads from HuggingFace if needed)."""
    if loading_model:
        raise HTTPException(409, "Another model is currently loading")
    if req.model_id == model_id_str and pipeline is not None:
        return {"status": "ok", "model": model_id_str, "message": "already loaded"}
    try:
        load_model_by_id(req.model_id, is_swap=True)
    except Exception as e:
        log.error(f"Failed to load model {req.model_id}: {e}")
        raise HTTPException(500, f"Failed to load model: {e}")
    return {"status": "ok", "model": model_id_str}

@app.post("/v1/model/unload")
async def unload_model_endpoint():
    """Manually unload the model to free VRAM immediately."""
    if pipeline is None:
        return {"status": "ok", "message": "model already unloaded"}
    unload_model()
    return {"status": "ok", "message": "model unloaded, VRAM released"}

@app.get("/v1/model/info")
async def model_info():
    """Return current model info."""
    return {
        "model": model_id_str,
        "status": "loading" if loading_model else ("loaded" if pipeline else "unloaded"),
        "idle_timeout": IDLE_TIMEOUT,
        "vram_held": pipeline is not None,
    }


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    # Server is healthy even if model is unloaded (it auto-reloads on demand)
    return {
        "status": "ok",
        "model": model_id_str,
        "model_loaded": pipeline is not None,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8178"))
    log.info(f"Starting FTML Whisper Server on port {port}")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
