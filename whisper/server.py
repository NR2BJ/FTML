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
import time
import wave
from contextlib import asynccontextmanager

import threading
import numpy as np
import librosa
import uvicorn
from fastapi import FastAPI, File, Form, UploadFile, HTTPException, Request
from fastapi.responses import PlainTextResponse, JSONResponse
from pydantic import BaseModel
from inference_runtime import ModelGate
from subtitle_processing import chunks_to_vtt, find_gaps, merge_chunks, normalize_chunks

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
CHUNK_OVERLAP_S = int(os.environ.get("CHUNK_OVERLAP_S", "5"))  # overlap to protect sentence boundaries


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle for FastAPI."""
    mid = os.environ.get("MODEL_ID", DEFAULT_MODEL_ID)
    await asyncio.to_thread(load_model_by_id, mid)
    if IDLE_TIMEOUT > 0:
        log.info(f"VRAM auto-release enabled: model unloads after {IDLE_TIMEOUT}s idle")
    else:
        log.info("VRAM auto-release disabled (IDLE_TIMEOUT=0)")
    yield
    await asyncio.to_thread(gate.close)


# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------
app = FastAPI(title="FTML Whisper Server", lifespan=lifespan)
pipeline = None
model_id_str = None
loading_model = False

# VRAM auto-release: unload model after idle timeout to free GPU memory.
# The model is automatically reloaded on the next inference request.
IDLE_TIMEOUT = int(os.environ.get("IDLE_TIMEOUT", "120"))  # seconds (0 = disabled)
gate = ModelGate(IDLE_TIMEOUT)
model_lock = gate.lock
if not 0 <= CHUNK_OVERLAP_S < CHUNK_DURATION_S:
    raise ValueError("CHUNK_OVERLAP_S must be nonnegative and smaller than CHUNK_DURATION_S")

# ---------------------------------------------------------------------------
# Model loading / unloading
# ---------------------------------------------------------------------------

@gate.operation
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
        model_path = snapshot_download(mid, revision=os.environ.get("MODEL_REVISION") or None)
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


gate.on_idle = unload_model


def ensure_model_loaded():
    """Ensure the model is loaded, reloading if it was unloaded for VRAM release."""
    global pipeline
    if pipeline is not None:
        return
    mid = model_id_str or os.environ.get("MODEL_ID", DEFAULT_MODEL_ID)
    log.info(f"Reloading model for inference: {mid}")
    load_model_by_id(mid)


def decode_audio(audio_bytes: bytes) -> np.ndarray:
    """Decode audio bytes to 16kHz mono float32 numpy array."""
    audio_io = io.BytesIO(audio_bytes)
    audio, _ = librosa.load(audio_io, sr=16000, mono=True)
    return audio.astype(np.float32)


def wav_frames_to_audio(frames: bytes, channels: int) -> np.ndarray:
    """Convert PCM16 WAV frames to normalized float32 audio."""
    audio = np.frombuffer(frames, dtype=np.int16)
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    return (audio.astype(np.float32) / 32768.0)


GAP_THRESHOLD_S = float(os.environ.get("GAP_THRESHOLD_S", "15"))
GAP_MAX_RETRY_S = float(os.environ.get("GAP_MAX_RETRY_S", "300"))


def check_cancelled(cancel):
    if cancel is not None and cancel.is_set():
        raise InterruptedError("Transcription cancelled")


def _recover_gaps(audio_getter, chunks, config, total_duration, sr=16000, cancel=None):
    if GAP_THRESHOLD_S <= 0 or GAP_MAX_RETRY_S <= 0:
        return chunks
    budget = GAP_MAX_RETRY_S
    for start, end in find_gaps(chunks, total_duration, GAP_THRESHOLD_S):
        # Limit both peak memory and total retry work for very long silent gaps.
        while start < end and budget > 0:
            check_cancelled(cancel)
            window_end = min(end, start + 30, start + budget)
            begin_sample = max(0, int((start-2) * sr))
            end_sample = min(int(total_duration * sr), int((window_end+2) * sr))
            audio = audio_getter(begin_sample, end_sample)
            budget -= window_end-start
            # Only skip digital silence, not quiet speech; this is not VAD.
            if audio.size and np.any(audio):
                result = pipeline.generate(audio, config)
                check_cancelled(cancel)
                recovered = normalize_chunks(getattr(result, "chunks", []), begin_sample/sr, total_duration)
                recovered = [cue for cue in recovered if cue["start_ts"] >= start-1 and cue["end_ts"] <= window_end+1]
                chunks = merge_chunks(chunks, recovered)
            start = window_end
    return chunks


def _transcribe(audio_getter, total_duration, language, cancel=None):
    check_cancelled(cancel)
    ensure_model_loaded()
    config = pipeline.get_generation_config()
    config.return_timestamps = True
    config.task = "transcribe"
    config.language = f"<|{language}|>" if language and language != "auto" else ""
    started = time.monotonic()
    sr, position, chunks = 16000, 0, []
    total_samples = int(round(total_duration * sr))
    chunk_samples = CHUNK_DURATION_S * sr
    overlap_samples = CHUNK_OVERLAP_S * sr
    while position < total_samples:
        check_cancelled(cancel)
        end = min(position + chunk_samples, total_samples)
        result = pipeline.generate(audio_getter(position, end), config)
        check_cancelled(cancel)
        incoming = normalize_chunks(getattr(result, "chunks", []), position/sr, total_duration)
        chunks = merge_chunks(chunks, incoming)
        log.info("Transcribed %.1f/%.1fs, %d cues", end/sr, total_duration, len(chunks))
        if end == total_samples:
            break
        position = end - overlap_samples
    chunks = _recover_gaps(audio_getter, chunks, config, total_duration, sr, cancel)
    check_cancelled(cancel)
    return chunks, " ".join(cue["text"] for cue in chunks), time.monotonic()-started, total_duration


@gate.operation
def run_inference(audio, language="", cancel=None):
    return _transcribe(lambda start, end: audio[start:end], len(audio)/16000, language, cancel)


@gate.operation
def run_inference_wav(file_obj, language="", cancel=None):
    check_cancelled(cancel)
    file_obj.seek(0)
    with wave.open(file_obj, "rb") as wav:
        if wav.getframerate() != 16000 or wav.getsampwidth() != 2:
            raise wave.Error("Expected 16kHz PCM16 WAV")
        channels = wav.getnchannels()
        def read_audio(start, end):
            wav.setpos(start)
            return wav_frames_to_audio(wav.readframes(end-start), channels)
        return _transcribe(read_audio, wav.getnframes()/16000, language, cancel)


def _run_upload(file_obj, language, cancel):
    try:
        return run_inference_wav(file_obj, language, cancel)
    except (wave.Error, EOFError):
        check_cancelled(cancel)
        file_obj.seek(0)
        audio, _ = librosa.load(file_obj, sr=16000, mono=True)
        return run_inference(audio.astype(np.float32), language, cancel)


@app.post("/v1/audio/transcriptions")
async def transcribe_openai(
    request: Request,
    file: UploadFile = File(...),
    language: str = Form(default=""),
    response_format: str = Form(default="vtt"),
):
    cancel = threading.Event()
    await file.seek(0)
    future = asyncio.get_running_loop().run_in_executor(None, _run_upload, file.file, language, cancel)
    try:
        while not future.done():
            await asyncio.wait([future], timeout=0.25)
            if await request.is_disconnected():
                cancel.set()
        chunks, text, elapsed, duration = await asyncio.shield(future)
    except asyncio.CancelledError:
        cancel.set()
        # Keep the upload alive until the GPU call/thread has released it.
        try:
            await asyncio.shield(future)
        except Exception:
            pass
        raise
    except InterruptedError as exc:
        raise HTTPException(499, str(exc)) from exc
    except Exception as exc:
        log.exception("Inference failed")
        raise HTTPException(500, "Transcription failed; inspect server logs") from exc
    finally:
        cancel.set()
    if not chunks:
        raise HTTPException(422, "No valid timed speech found; no subtitle was saved")
    log.info("Completed %d cues in %.1fs", len(chunks), elapsed)
    if response_format == "vtt":
        return PlainTextResponse(chunks_to_vtt(chunks), media_type="text/vtt")
    if response_format == "verbose_json":
        return JSONResponse({"text": text, "language": language or "auto", "duration": duration, "segments": [
            {"id": index, "start": cue["start_ts"], "end": cue["end_ts"], "text": cue["text"]}
            for index, cue in enumerate(chunks)
        ]})
    return JSONResponse({"text": text})


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
        await asyncio.to_thread(load_model_by_id, req.model_id, True)
    except Exception as e:
        log.error(f"Failed to load model {req.model_id}: {e}")
        raise HTTPException(500, f"Failed to load model: {e}")
    return {"status": "ok", "model": model_id_str}

@app.post("/v1/model/unload")
async def unload_model_endpoint():
    """Manually unload the model to free VRAM immediately."""
    if pipeline is None:
        return {"status": "ok", "message": "model already unloaded"}
    await asyncio.to_thread(unload_model)
    return {"status": "ok", "message": "model unloaded, VRAM released"}

@app.get("/v1/model/info")
async def model_info():
    """Return current model info."""
    return {
        "model": model_id_str,
        "status": "loading" if loading_model else ("loaded" if pipeline else "unloaded"),
        "busy": gate.active > 0,
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
