"""
FTML Whisper Server — OpenVINO GenAI WhisperPipeline
Lightweight FastAPI server wrapping OpenVINO's WhisperPipeline for
Intel Arc GPU-accelerated speech-to-text with timestamp support.

Endpoints:
  POST /v1/audio/transcriptions  (OpenAI-compatible)
  POST /inference                (legacy compat)
  POST /v1/model/load            (runtime model swap)
  GET  /v1/model/info            (current model info)
  GET  /health
"""

import io
import os
import logging
import time

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

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------
app = FastAPI(title="FTML Whisper Server")
pipeline = None
model_id_str = None
model_lock = threading.Lock()
loading_model = False

# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------

def load_model_by_id(mid: str):
    """Load a WhisperPipeline for the given HuggingFace model ID."""
    global pipeline, model_id_str, loading_model
    import openvino_genai
    from huggingface_hub import snapshot_download

    device = os.environ.get("DEVICE", "GPU")
    loading_model = True
    try:
        log.info(f"Loading model: {mid} on device: {device}")
        model_path = snapshot_download(mid)
        log.info(f"Model path: {model_path}")
        new_pipeline = openvino_genai.WhisperPipeline(str(model_path), device)
        with model_lock:
            pipeline = new_pipeline
            model_id_str = mid
        log.info(f"WhisperPipeline loaded successfully on {device}")
    finally:
        loading_model = False


@app.on_event("startup")
async def startup():
    mid = os.environ.get("MODEL_ID", "OpenVINO/distil-whisper-large-v3-int8-ov")
    load_model_by_id(mid)


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
    """Convert WhisperPipeline chunks to WebVTT format."""
    lines = ["WEBVTT", ""]
    idx = 1
    for chunk in chunks:
        text = chunk.text.strip()
        if text:
            start = format_ts(chunk.start_ts)
            end = format_ts(chunk.end_ts)
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


def run_inference(audio: np.ndarray, language: str = ""):
    """Run whisper inference and return (chunks, full_text, elapsed)."""
    config = pipeline.get_generation_config()
    config.return_timestamps = True

    if language and language != "auto":
        config.language = f"<|{language}|>"

    t0 = time.time()
    result = pipeline.generate(audio, config)
    elapsed = time.time() - t0

    chunks = getattr(result, "chunks", [])
    full_text = "".join(c.text for c in chunks).strip() if chunks else str(result)

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
    if pipeline is None:
        raise HTTPException(503, "Model not loaded")

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
        segments = [{"start": c.start_ts, "end": c.end_ts, "text": c.text.strip()} for c in chunks]
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
    if pipeline is None:
        raise HTTPException(503, "Model not loaded")

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
    if req.model_id == model_id_str:
        return {"status": "ok", "model": model_id_str, "message": "already loaded"}
    try:
        load_model_by_id(req.model_id)
    except Exception as e:
        log.error(f"Failed to load model {req.model_id}: {e}")
        raise HTTPException(500, f"Failed to load model: {e}")
    return {"status": "ok", "model": model_id_str}

@app.get("/v1/model/info")
async def model_info():
    """Return current model info."""
    return {
        "model": model_id_str,
        "status": "loading" if loading_model else ("loaded" if pipeline else "not_loaded"),
    }


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    if pipeline is None:
        raise HTTPException(503, "Model not loaded")
    return {"status": "ok", "model": model_id_str}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8178"))
    log.info(f"Starting FTML Whisper Server on port {port}")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
