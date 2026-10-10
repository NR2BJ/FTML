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
from inference_runtime import ModelGate, STORAGE_FULL_MESSAGE, is_storage_full
from subtitle_processing import chunks_to_vtt, find_gaps, merge_chunks, timed_words_to_chunks, stitch_chunks, stabilize_short_cues, group_timed_words
from qwen_pipeline import MODELS as QWEN_MODELS
from qwen_alignment import QwenAlignmentError

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
WORD_TIMESTAMPS = os.environ.get("WHISPER_WORD_TIMESTAMPS", "true").lower() == "true"
word_timestamps_active = False


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle for FastAPI."""
    # 모델 다운로드/GPU 준비는 첫 작업에서 한다. 네트워크 장애로 HTTP 시작을 막지 않는다.
    log.info("Local ASR ready; default model loads on first task: %s", DEFAULT_MODEL_ID)
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
def load_model_by_id(mid: str, is_swap: bool = False, cancel=None):
    """Load a WhisperPipeline for the given HuggingFace model ID.

    Args:
        mid: HuggingFace model ID (e.g. "OpenVINO/whisper-large-v3-int8-ov")
        is_swap: If True, this is a runtime model swap (unload previous first)
    """
    global pipeline, model_id_str, loading_model, word_timestamps_active
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
        if mid in QWEN_MODELS:
            from qwen_pipeline import QwenPipeline
            new_pipeline = QwenPipeline(mid, device, cancel)
            with model_lock:
                pipeline, model_id_str, word_timestamps_active = new_pipeline, mid, True
            return
        model_path = snapshot_download(mid, revision=os.environ.get("MODEL_REVISION") or None)
        log.info(f"Model path: {model_path}")
        word_timestamps_active = WORD_TIMESTAMPS and hasattr(openvino_genai.WhisperGenerationConfig(), "word_timestamps")
        if word_timestamps_active:
            try:
                new_pipeline = openvino_genai.WhisperPipeline(str(model_path), device, word_timestamps=True)
            except RuntimeError:
                log.warning("단어 시각 지원으로 모델을 준비하지 못했습니다. 문장 시각으로 다시 준비합니다.", exc_info=True)
                word_timestamps_active = False
                gc.collect()
                new_pipeline = openvino_genai.WhisperPipeline(str(model_path), device)
        else:
            new_pipeline = openvino_genai.WhisperPipeline(str(model_path), device)
        log.info("Whisper timing mode: %s", "word" if word_timestamps_active else "segment (word timing disabled or unavailable)")
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
    mid = model_id_str or DEFAULT_MODEL_ID
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
GAP_MAX_RETRY_S = float(os.environ.get("GAP_MAX_RETRY_S", "0"))


def check_cancelled(cancel):
    if cancel is not None and cancel.is_set():
        raise InterruptedError("Transcription cancelled")


def _generate_timed_chunks(audio, config, offset, total_duration, cancel=None, depth=0, word_output=False):
    check_cancelled(cancel)
    if not audio.size or not np.any(audio):
        return []
    try:
        result = pipeline.generate(audio, config)
    except QwenAlignmentError as exc:
        window = (offset, offset + len(audio)/16000)
        log.warning("Qwen 정렬 검사 실패: %.3f~%.3fs, 이유=%s, 재처리 깊이=%d",
                    *window, exc.reason, depth)
        # 정상 구간은 다시 인식하지 않는다. 실패한 30초 창만 최대 두 번
        # 나누고, 단어를 자르지 않도록 경계 앞뒤 1초를 겹쳐 읽는다.
        if model_id_str not in QWEN_MODELS or depth >= 2 or len(audio) <= 8*16000:
            raise QwenAlignmentError(exc.reason, window) from exc
        check_cancelled(cancel)
        midpoint = len(audio)//2
        left_end, right_start = midpoint + 16000, midpoint - 16000
        before = _generate_timed_chunks(audio[:left_end], config, offset, total_duration, cancel, depth+1, word_output)
        after = _generate_timed_chunks(audio[right_start:], config, offset + right_start/16000, total_duration, cancel, depth+1, word_output)
        recovered = stitch_chunks(before, after, offset + midpoint/16000)
        if not recovered:
            raise QwenAlignmentError("empty_retry", window) from exc
        if depth == 0:
            pipeline.recovered_alignment_windows = getattr(pipeline, "recovered_alignment_windows", 0) + 1
            log.info("Qwen 정렬 구간 재처리 완료: %.3f~%.3fs, %d개 자막", *window, len(recovered))
        return recovered
    check_cancelled(cancel)
    return timed_words_to_chunks(getattr(result, "words", None), getattr(result, "chunks", []) or [], offset, min(total_duration, offset + len(audio)/16000),
                                 engine="qwen" if model_id_str in QWEN_MODELS else "whisper", word_output=word_output)


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
                recovered = _generate_timed_chunks(audio, config, begin_sample/sr, total_duration, cancel, word_output=True)
                recovered = [cue for cue in recovered if cue["start_ts"] >= start-1 and cue["end_ts"] <= window_end+1]
                chunks = merge_chunks(chunks, recovered, recovery=True)
            start = window_end
    return chunks


def _transcribe(audio_getter, total_duration, language, cancel=None, model="", prompt="", observer=None):
    check_cancelled(cancel)
    if model and model != model_id_str:
        load_model_by_id(model, is_swap=True, cancel=cancel)
        check_cancelled(cancel)
    ensure_model_loaded()
    if model_id_str in QWEN_MODELS:
        pipeline.collapsed_words = 0
        pipeline.recovered_alignment_windows = 0
    config = pipeline.get_generation_config()
    config.return_timestamps = True
    if word_timestamps_active:
        config.word_timestamps = True
    config.task = "transcribe"
    config.language = f"<|{language}|>" if language and language != "auto" else ""
    if model_id_str in QWEN_MODELS:
        config.context = prompt
    elif prompt and hasattr(config, "hotwords"):
        config.hotwords = prompt
    started = time.monotonic()
    sr, position, chunks, last_window_end = 16000, 0, [], 0
    total_samples = int(round(total_duration * sr))
    chunk_samples = max(30, getattr(pipeline, "chunk_seconds", CHUNK_DURATION_S)) * sr
    overlap_samples = min(max(0, CHUNK_OVERLAP_S) * sr, chunk_samples // 2)
    while position < total_samples:
        check_cancelled(cancel)
        end = min(position + chunk_samples, total_samples)
        audio = audio_getter(position, end)
        if not audio.size or not np.any(audio):
            position = end
            continue
        incoming = _generate_timed_chunks(audio, config, position/sr, total_duration, cancel, word_output=True)
        if observer is not None and not getattr(observer, "failed", False):
            try:
                observer.observe(audio, incoming, position/sr)
            except Exception:
                observer.failed = True
                log.exception("말소리 검출 실패: 자막과 원음은 유지합니다")
        seam = (position+max(position, last_window_end))/2/sr
        chunks = stitch_chunks(chunks, incoming, seam) if position and chunks else incoming
        last_window_end = end
        log.info("Transcribed %.1f/%.1fs, %d cues", end/sr, total_duration, len(chunks))
        if end == total_samples:
            break
        position = end - overlap_samples
    chunks = _recover_gaps(audio_getter, chunks, config, total_duration, sr, cancel)
    if model_id_str not in QWEN_MODELS and observer is not None and getattr(observer, "adjust_timing", False) and not getattr(observer, "failed", False):
        from speech_observer import refine_whisper_onsets
        chunks, observer.adjusted_onsets = refine_whisper_onsets(chunks, observer.merged_spans())
    chunks = group_timed_words(chunks, total_duration, gap_threshold=0.65 if model_id_str in QWEN_MODELS else 0.3)
    chunks = [{key: value for key, value in cue.items() if not key.startswith("_")} for cue in chunks]
    if model_id_str in QWEN_MODELS:
        chunks = stabilize_short_cues(chunks, total_duration)
    # 완전한 디지털 무음만 자른다. 배경음/작은 목소리를 VAD처럼 판정하지 않는다.
    trimmed = []
    for cue in chunks:
        check_cancelled(cancel)
        start, end = int(cue["start_ts"] * sr), int(cue["end_ts"] * sr)
        # 긴/잘못된 자막 하나 때문에 큰 음성 배열을 만들지 않는다.
        if end-start > 30*sr:
            trimmed.append(cue)
            continue
        audio = audio_getter(start, end)
        nonzero = np.flatnonzero(audio)
        if nonzero.size:
            cue = dict(cue)
            cue["start_ts"] = max(cue["start_ts"], (start + nonzero[0])/sr - 0.02)
            cue["end_ts"] = min(cue["end_ts"], (start + nonzero[-1]+1)/sr + 0.02)
            trimmed.append(cue)
    chunks = trimmed
    check_cancelled(cancel)
    return chunks, " ".join(cue["text"] for cue in chunks), time.monotonic()-started, total_duration


@gate.operation
def run_inference(audio, language="", cancel=None, model="", prompt="", observer=None):
    return _transcribe(lambda start, end: audio[start:end], len(audio)/16000, language, cancel, model, prompt, observer)


@gate.operation
def run_inference_wav(file_obj, language="", cancel=None, model="", prompt="", observer=None):
    check_cancelled(cancel)
    file_obj.seek(0)
    with wave.open(file_obj, "rb") as wav:
        if wav.getframerate() != 16000 or wav.getsampwidth() != 2:
            raise wave.Error("Expected 16kHz PCM16 WAV")
        channels = wav.getnchannels()
        def read_audio(start, end):
            wav.setpos(start)
            return wav_frames_to_audio(wav.readframes(end-start), channels)
        return _transcribe(read_audio, wav.getnframes()/16000, language, cancel, model, prompt, observer)


@gate.operation
def _run_upload(file_obj, language, cancel, model="", prompt="", observe_speech=False):
    started = time.monotonic()
    if pipeline is not None and hasattr(pipeline, "collapsed_words"):
        pipeline.collapsed_words = 0
    observer = None
    timing_boundaries = (model or DEFAULT_MODEL_ID) not in QWEN_MODELS and os.environ.get("WHISPER_SPEECH_BOUNDARIES", "true").lower() == "true"
    if observe_speech or timing_boundaries:
        try:
            from speech_observer import SpeechObserver
            observer = SpeechObserver()
            observer.adjust_timing = timing_boundaries
        except Exception:
            log.exception("말소리 경계를 읽지 못해 원래 추출 시각을 유지합니다")
    try:
        result = run_inference_wav(file_obj, language, cancel, model, prompt, observer)
    except (wave.Error, EOFError):
        check_cancelled(cancel)
        file_obj.seek(0)
        audio, _ = librosa.load(file_obj, sr=16000, mono=True)
        result = run_inference(audio.astype(np.float32), language, cancel, model, prompt, observer)
    chunks, text, elapsed, duration = result
    diagnostics = observer.finish(chunks) if observer is not None and not getattr(observer, "failed", False) else {}
    if timing_boundaries:
        diagnostics["timing_adjusted_onsets"] = getattr(observer, "adjusted_onsets", 0)
        diagnostics["speech_boundaries_available"] = observer is not None and not getattr(observer, "failed", False)
    diagnostics.update({"model":model_id_str,"word_timestamps":word_timestamps_active,"gap_recovery":GAP_MAX_RETRY_S>0})
    if model_id_str in QWEN_MODELS:
        diagnostics["timing_review_words"] = getattr(pipeline, "collapsed_words", 0)
        diagnostics["timing_recovered_windows"] = getattr(pipeline, "recovered_alignment_windows", 0)
        pipeline.collapsed_words = 0
    log.info("추출 진단: %s", diagnostics)
    return chunks, text, time.monotonic()-started, duration, diagnostics


@app.post("/v1/audio/transcriptions")
async def transcribe_openai(
    request: Request,
    file: UploadFile = File(...),
    language: str = Form(default=""),
    response_format: str = Form(default="vtt"),
    model: str = Form(default=""),
    prompt: str = Form(default="", max_length=4000),
    reference_lyrics: str = Form(default="", max_length=24000),
    observe_speech: bool = Form(default=False),
):
    model = model or DEFAULT_MODEL_ID
    if model != DEFAULT_MODEL_ID and model not in QWEN_MODELS:
        raise HTTPException(400, "지원하지 않는 추출 모델입니다")
    if reference_lyrics:
        raise HTTPException(400, "가사 수동 보정은 더 이상 지원하지 않습니다")
    cancel = threading.Event()
    await file.seek(0)
    future = asyncio.get_running_loop().run_in_executor(None, _run_upload, file.file, language, cancel, model, prompt, observe_speech)
    try:
        while not future.done():
            await asyncio.wait([future], timeout=0.25)
            if await request.is_disconnected():
                cancel.set()
        chunks, text, elapsed, duration, diagnostics = await asyncio.shield(future)
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
    except ValueError as exc:
        log.warning("자막 추출 검증 실패: %s", exc)
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        log.exception("Inference failed")
        if is_storage_full(exc):
            raise HTTPException(507, STORAGE_FULL_MESSAGE) from exc
        raise HTTPException(500, "Transcription failed; inspect server logs") from exc
    finally:
        cancel.set()
    if not chunks:
        raise HTTPException(422, "No valid timed speech found; no subtitle was saved")
    log.info("Completed %d cues in %.1fs", len(chunks), elapsed)
    if response_format == "vtt":
        return PlainTextResponse(chunks_to_vtt(chunks), media_type="text/vtt")
    if response_format == "ftml_json":
        return JSONResponse({"vtt": chunks_to_vtt(chunks), "diagnostics":diagnostics})
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
    if req.model_id != DEFAULT_MODEL_ID and req.model_id not in QWEN_MODELS:
        raise HTTPException(400, "지원하지 않는 추출 모델입니다")
    if loading_model:
        raise HTTPException(409, "Another model is currently loading")
    if req.model_id == model_id_str and pipeline is not None:
        return {"status": "ok", "model": model_id_str, "message": "already loaded"}
    try:
        await asyncio.to_thread(load_model_by_id, req.model_id, True)
    except Exception as e:
        log.error(f"Failed to load model {req.model_id}: {e}")
        if is_storage_full(e):
            raise HTTPException(507, STORAGE_FULL_MESSAGE) from e
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
        "timing_mode": "word" if word_timestamps_active else "segment",
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
