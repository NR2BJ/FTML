"""
FTML Whisper Server — OpenVINO GenAI WhisperPipeline
Lightweight FastAPI server wrapping OpenVINO's WhisperPipeline for
Intel Arc GPU-accelerated speech-to-text with timestamp support.

Pipeline (when ENABLE_VOCAL_SEP=1):
  Audio → Vocal separation via audio-separator (CPU)
    → VAD segment extraction → per-segment whisper inference (GPU)
    → timestamp remapping → VTT

Endpoints:
  POST /v1/audio/transcriptions  (OpenAI-compatible)
  POST /inference                (legacy compat)
  POST /v1/model/load            (runtime model swap)
  GET  /v1/model/info            (current model info)
  GET  /health
"""

import gc
import io
import os
import logging
import shutil
import tempfile
import time

import threading
import numpy as np
import librosa
import soundfile as sf
import uvicorn
from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.responses import PlainTextResponse, JSONResponse
from pydantic import BaseModel
from silero_vad_lite import SileroVAD

logging.basicConfig(
    level=logging.INFO,
    format="[whisper] %(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("whisper")

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------
app = FastAPI(title="FTML Whisper Server")
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

# Silero VAD for filtering non-speech audio (BGM, effects, silence)
# before sending to Whisper — prevents hallucination on non-speech segments.
vad_model = SileroVAD(16000)

# Vocal separation via audio-separator (lazy loaded)
ENABLE_VOCAL_SEP = os.environ.get("ENABLE_VOCAL_SEP",
                    os.environ.get("ENABLE_DEMUCS", "1")) == "1"
VOCAL_SEP_MODEL = os.environ.get("VOCAL_SEP_MODEL", "UVR_MDXNET_KARA_2.onnx")
_vocal_separator = None
_vocal_sep_lock = threading.Lock()

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
    mid = model_id_str or os.environ.get("MODEL_ID", "OpenVINO/distil-whisper-large-v3-int8-ov")
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


@app.on_event("startup")
async def startup():
    mid = os.environ.get("MODEL_ID", "OpenVINO/distil-whisper-large-v3-int8-ov")
    load_model_by_id(mid)
    if IDLE_TIMEOUT > 0:
        log.info(f"VRAM auto-release enabled: model unloads after {IDLE_TIMEOUT}s idle")
    else:
        log.info("VRAM auto-release disabled (IDLE_TIMEOUT=0)")
    log.info(f"Vocal separation: {'enabled' if ENABLE_VOCAL_SEP else 'disabled'}"
             f"{f' (model={VOCAL_SEP_MODEL})' if ENABLE_VOCAL_SEP else ''}")


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
            continue

        # Skip 3+ consecutive identical texts (repetition hallucination)
        if text == prev_text:
            repeat_count += 1
            if repeat_count >= 2:
                continue
        else:
            repeat_count = 0
        prev_text = text

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
# Vocal separation (audio-separator)
# ---------------------------------------------------------------------------

def _get_vocal_separator():
    """Lazy-load audio-separator (downloads model on first use)."""
    global _vocal_separator, ENABLE_VOCAL_SEP
    with _vocal_sep_lock:
        if _vocal_separator is not None:
            return _vocal_separator
        try:
            log.info(f"Loading audio-separator with model {VOCAL_SEP_MODEL}...")
            from audio_separator.separator import Separator
            _vocal_separator = Separator(
                output_format="WAV",
                output_single_stem="Vocals",
                model_file_dir="/root/.cache/huggingface/audio-separator-models",
            )
            _vocal_separator.load_model(model_filename=VOCAL_SEP_MODEL)
            log.info(f"audio-separator model loaded: {VOCAL_SEP_MODEL}")
            return _vocal_separator
        except Exception as e:
            log.error(f"audio-separator init failed: {e}. Disabling vocal separation.")
            ENABLE_VOCAL_SEP = False
            raise


def vocal_separate(audio_16k: np.ndarray) -> np.ndarray:
    """Extract vocals from audio using audio-separator.

    audio-separator only works with file paths, so we:
    1. Write input audio to a temp WAV file
    2. Run separation
    3. Read vocals WAV back as numpy
    4. Clean up temp files

    Args:
        audio_16k: 16kHz mono float32 numpy array
    Returns:
        vocals_16k: 16kHz mono float32 numpy array (vocals only)
    """
    separator = _get_vocal_separator()

    tmp_dir = tempfile.mkdtemp(prefix="vocal_sep_")
    try:
        # Write input audio as WAV (16kHz mono)
        input_path = os.path.join(tmp_dir, "input.wav")
        sf.write(input_path, audio_16k, 16000, subtype='FLOAT')

        # Hold lock during separation (mutates separator.output_dir)
        with _vocal_sep_lock:
            separator.output_dir = tmp_dir
            t0 = time.time()
            output_files = separator.separate(input_path)
            elapsed = time.time() - t0

        if not output_files:
            raise RuntimeError("audio-separator returned no output files")

        # Find the vocals output file
        vocals_path = None
        for f in output_files:
            full_path = f if os.path.isabs(f) else os.path.join(tmp_dir, f)
            if os.path.exists(full_path):
                vocals_path = full_path
                break

        if vocals_path is None:
            raise RuntimeError(f"Vocals output file not found. Got: {output_files}")

        # Read vocals WAV and resample to 16kHz mono
        vocals, _ = librosa.load(vocals_path, sr=16000, mono=True)

        log.info(f"Vocal separation done in {elapsed:.1f}s "
                 f"({len(audio_16k)/16000:.1f}s audio, model={VOCAL_SEP_MODEL})")

        return vocals.astype(np.float32)

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# VAD segment extraction
# ---------------------------------------------------------------------------

def vad_speech_timestamps(audio: np.ndarray, sr: int = 16000,
                           threshold: float = 0.5,
                           min_speech_ms: int = 250,
                           min_silence_ms: int = 500) -> list[dict]:
    """Extract speech segments using Silero VAD (sample index based).

    Returns list of {'start': int, 'end': int} with sample indices.
    """
    chunk_size = int(sr * 0.032)  # 32ms = 512 samples at 16kHz
    min_speech_samples = int(sr * min_speech_ms / 1000)
    min_silence_samples = int(sr * min_silence_ms / 1000)

    segments = []
    is_speech = False
    speech_start = 0
    silence_counter = 0  # consecutive silence chunks

    for i in range(0, len(audio) - chunk_size + 1, chunk_size):
        chunk_bytes = audio[i:i + chunk_size].astype(np.float32).tobytes()
        prob = vad_model.process(chunk_bytes)

        if prob >= threshold:
            if not is_speech:
                speech_start = i
                is_speech = True
            silence_counter = 0
        else:
            if is_speech:
                silence_counter += 1
                if silence_counter * chunk_size >= min_silence_samples:
                    speech_end = i - (silence_counter - 1) * chunk_size
                    if (speech_end - speech_start) >= min_speech_samples:
                        segments.append({'start': speech_start, 'end': speech_end})
                    is_speech = False
                    silence_counter = 0

    # Close last segment
    if is_speech:
        speech_end = len(audio) - silence_counter * chunk_size
        if (speech_end - speech_start) >= min_speech_samples:
            segments.append({'start': speech_start, 'end': speech_end})

    return segments


def merge_segments(segments: list[dict], sr: int = 16000,
                   gap_threshold_s: float = 1.5,
                   max_duration_s: float = 28.0,
                   min_duration_s: float = 0.5) -> list[dict]:
    """Merge close VAD segments and enforce duration limits.

    Args:
        segments: list of {'start': sample_idx, 'end': sample_idx}
        gap_threshold_s: merge segments closer than this (seconds)
        max_duration_s: split segments longer than this (whisper 30s window)
        min_duration_s: drop segments shorter than this

    Returns:
        merged list of {'start': sample_idx, 'end': sample_idx}
    """
    if not segments:
        return []

    gap_samples = int(sr * gap_threshold_s)
    max_samples = int(sr * max_duration_s)
    min_samples = int(sr * min_duration_s)

    merged = [dict(segments[0])]

    for seg in segments[1:]:
        prev = merged[-1]
        gap = seg['start'] - prev['end']

        # Merge if gap is small AND combined duration stays under max
        combined_dur = seg['end'] - prev['start']
        if gap <= gap_samples and combined_dur <= max_samples:
            prev['end'] = seg['end']
        else:
            merged.append(dict(seg))

    # Split segments that are too long
    result = []
    for seg in merged:
        dur = seg['end'] - seg['start']
        if dur <= max_samples:
            if dur >= min_samples:
                result.append(seg)
        else:
            # Split into max_duration_s chunks
            pos = seg['start']
            while pos < seg['end']:
                chunk_end = min(pos + max_samples, seg['end'])
                if (chunk_end - pos) >= min_samples:
                    result.append({'start': pos, 'end': chunk_end})
                pos = chunk_end

    return result


# ---------------------------------------------------------------------------
# Inference
# ---------------------------------------------------------------------------

def run_segment_inference(audio: np.ndarray, segments: list[dict],
                          language: str = "", sr: int = 16000):
    """Run whisper inference on individual VAD segments, then remap timestamps.

    This is the core anti-hallucination strategy: instead of feeding the entire
    audio (with silence/BGM gaps) to whisper, we cut out speech segments and
    run inference on each one individually. This prevents whisper from
    hallucinating on non-speech windows.

    Args:
        audio: full audio array (16kHz mono float32)
        segments: list of {'start': sample_idx, 'end': sample_idx}
        language: language code or "" for auto
        sr: sample rate

    Returns:
        (all_chunks, full_text, total_elapsed)
    """
    ensure_model_loaded()

    config = pipeline.get_generation_config()
    config.return_timestamps = True
    config.task = "transcribe"
    if language and language != "auto":
        config.language = f"<|{language}|>"

    log.info(f"Segmented inference: {len(segments)} segments, "
             f"model={model_id_str}, language={language or 'auto'}")

    all_chunks = []
    total_elapsed = 0.0
    pad_samples = int(sr * 0.2)  # 200ms padding on each side

    for i, seg in enumerate(segments):
        seg_start_s = seg['start'] / sr
        seg_end_s = seg['end'] / sr

        # Extract segment with padding (clamped to audio bounds)
        extract_start = max(0, seg['start'] - pad_samples)
        extract_end = min(len(audio), seg['end'] + pad_samples)
        segment_audio = audio[extract_start:extract_end]

        # Offset for timestamp remapping: segment start in absolute time
        # Subtract the leading padding so whisper's local timestamps align
        pad_offset_s = (seg['start'] - extract_start) / sr
        absolute_offset_s = seg_start_s - pad_offset_s

        t0 = time.time()
        result = pipeline.generate(segment_audio, config)
        elapsed = time.time() - t0
        total_elapsed += elapsed

        chunks = getattr(result, "chunks", [])

        # Remap timestamps from local (segment-relative) to absolute
        seg_duration_s = len(segment_audio) / sr
        for c in chunks:
            text = c.text.strip()
            if not text:
                continue

            # Remap: local timestamp + absolute offset
            abs_start = c.start_ts + absolute_offset_s
            abs_end = c.end_ts + absolute_offset_s

            # Clamp to segment boundaries
            abs_start = max(seg_start_s, abs_start)
            abs_end = min(seg_end_s, abs_end)

            if abs_end <= abs_start:
                continue

            all_chunks.append({
                'text': text,
                'start_ts': abs_start,
                'end_ts': abs_end,
            })

        seg_text = " ".join(c.text.strip() for c in chunks if c.text.strip())
        log.info(f"  Segment {i+1}/{len(segments)} "
                 f"[{seg_start_s:.1f}s-{seg_end_s:.1f}s] "
                 f"({elapsed:.1f}s): {seg_text[:80]}")

    full_text = " ".join(c['text'] for c in all_chunks)

    # Schedule idle unload after all inference completes
    _schedule_idle_unload()

    return all_chunks, full_text, total_elapsed


def run_inference(audio: np.ndarray, language: str = ""):
    """Run the full transcription pipeline.

    When ENABLE_VOCAL_SEP=1 (default):
      1. Vocal separation via audio-separator (remove BGM/SFX)
      2. VAD segment extraction (find speech regions)
      3. Merge close segments (gap < 1.5s, max 28s)
      4. Per-segment whisper inference with timestamp remapping

    When ENABLE_VOCAL_SEP=0 (fallback):
      Original method — replace non-speech with silence, single inference.
    """
    if ENABLE_VOCAL_SEP:
        return _run_inference_vocal_sep(audio, language)
    else:
        return _run_inference_legacy(audio, language)


def _run_inference_vocal_sep(audio: np.ndarray, language: str = ""):
    """Vocal separation + VAD segment-based inference pipeline."""
    # Step 1: Vocal separation
    t0 = time.time()
    try:
        vocals = vocal_separate(audio)
    except Exception as e:
        log.error(f"Vocal separation failed: {e}, falling back to legacy inference")
        # Without vocal separation, VAD on raw audio is unreliable (BGM masks speech).
        # Fall back to legacy whole-audio inference instead of segment-based.
        return _run_inference_legacy(audio, language)
    sep_time = time.time() - t0

    # Step 2: VAD on vocals (clean audio after separation) to find speech segments
    speech_segments = vad_speech_timestamps(vocals)
    total_speech = sum(s['end'] - s['start'] for s in speech_segments) / 16000
    log.info(f"VAD: {len(speech_segments)} raw segments, "
             f"{total_speech:.1f}s speech / {len(vocals)/16000:.1f}s total")

    if not speech_segments:
        log.info("No speech detected after vocal separation, skipping inference")
        _schedule_idle_unload()
        return [], "", 0.0

    # Step 3: Merge close segments
    merged = merge_segments(speech_segments)
    merged_speech = sum((s['end'] - s['start']) / 16000 for s in merged)
    log.info(f"Merged: {len(merged)} segments, {merged_speech:.1f}s total")

    # Step 4: Per-segment whisper inference
    all_chunks, full_text, inference_time = run_segment_inference(
        vocals, merged, language
    )

    total_time = sep_time + inference_time
    log.info(f"Pipeline complete: vocal_sep={sep_time:.1f}s, "
             f"inference={inference_time:.1f}s, total={total_time:.1f}s, "
             f"{len(all_chunks)} chunks")

    return all_chunks, full_text, total_time


def _run_inference_legacy(audio: np.ndarray, language: str = ""):
    """Legacy inference: VAD silence replacement + single whisper call."""
    ensure_model_loaded()

    # VAD preprocessing: replace non-speech with silence
    segments = vad_speech_timestamps(audio)
    total_speech = sum(s['end'] - s['start'] for s in segments) / 16000
    log.info(f"VAD: {len(segments)} segments, {total_speech:.1f}s speech / {len(audio)/16000:.1f}s total")

    if not segments:
        log.info("No speech detected, skipping inference")
        _schedule_idle_unload()
        return [], "", 0.0

    # Replace non-speech with silence
    vad_audio = np.zeros_like(audio)
    for seg in segments:
        vad_audio[seg['start']:seg['end']] = audio[seg['start']:seg['end']]

    log.info(f"Inference using model: {model_id_str}, language: {language or 'auto'}")

    config = pipeline.get_generation_config()
    config.return_timestamps = True
    config.task = "transcribe"

    if language and language != "auto":
        config.language = f"<|{language}|>"

    log.info(f"Config: task={config.task}, language={config.language}")

    t0 = time.time()
    result = pipeline.generate(vad_audio, config)
    elapsed = time.time() - t0

    chunks = getattr(result, "chunks", [])
    full_text = "".join(c.text for c in chunks).strip() if chunks else str(result)

    # Debug: log first 3 chunks to verify output language
    for i, c in enumerate(chunks[:3]):
        log.info(f"  chunk[{i}]: [{c.start_ts:.1f}-{c.end_ts:.1f}] {c.text.strip()}")

    # Schedule idle unload after inference completes
    _schedule_idle_unload()

    return chunks, full_text, elapsed


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
        chunks, full_text, elapsed = run_inference(audio, language)
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
# whisper.cpp-compatible endpoint (legacy)
# ---------------------------------------------------------------------------

@app.post("/inference")
async def transcribe_legacy(
    file: UploadFile = File(...),
    language: str = Form(default=""),
    response_format: str = Form(default="vtt"),
    temperature: str = Form(default="0.0"),
):
    """Legacy endpoint matching whisper.cpp /inference for backwards compat."""
    if loading_model:
        raise HTTPException(503, "Model is loading, please wait")

    audio_bytes = await file.read()
    log.info(f"[legacy] Received: {file.filename} ({len(audio_bytes)} bytes)")

    try:
        audio = decode_audio(audio_bytes)
    except Exception as e:
        raise HTTPException(400, f"Failed to decode audio: {e}")

    log.info(f"[legacy] Audio: {len(audio)/16000:.1f}s")

    try:
        chunks, full_text, elapsed = run_inference(audio, language)
    except Exception as e:
        raise HTTPException(500, f"Inference failed: {e}")

    log.info(f"[legacy] Done: {len(chunks)} chunks in {elapsed:.1f}s")

    if response_format == "vtt":
        vtt = chunks_to_vtt(chunks) if chunks else f"WEBVTT\n\n1\n00:00:00.000 --> 99:59:59.999\n{full_text}\n"
        return PlainTextResponse(vtt, media_type="text/vtt")
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
        "vocal_sep_enabled": ENABLE_VOCAL_SEP,
        "vocal_sep_model": VOCAL_SEP_MODEL if ENABLE_VOCAL_SEP else None,
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
