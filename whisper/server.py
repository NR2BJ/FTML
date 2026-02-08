"""
FTML Whisper Server — OpenVINO GenAI WhisperPipeline
Lightweight FastAPI server wrapping OpenVINO's WhisperPipeline for
Intel Arc GPU-accelerated speech-to-text with timestamp support.

Pipeline (PREPROCESS_MODE):
  'adaptive' (default):
    Audio → BGM detection (spectral analysis, <1s)
      → lightweight filtering (highpass/spectral subtraction, VAD only)
      → VAD segment extraction → per-segment whisper on ORIGINAL audio (GPU)
  'vocal_sep':
    Audio → MDX-Net ONNX vocal separation (CPU, slow)
      → VAD → per-segment whisper on vocals (GPU)
  'raw' (baseline):
    Audio → Whisper 통째로 (VAD/전처리 없음, 성능 baseline 측정용)
  'none':
    Audio → VAD → silence replacement → single whisper call (GPU)

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
import re
import time
from contextlib import asynccontextmanager

import threading
import numpy as np
import librosa
import requests
import uvicorn
from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.responses import PlainTextResponse, JSONResponse
from pydantic import BaseModel
from silero_vad_lite import SileroVAD
from scipy.signal import butter, sosfilt
import scipy.signal

logging.basicConfig(
    level=logging.INFO,
    format="[whisper] %(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("whisper")

DEFAULT_MODEL_ID = "OpenVINO/whisper-large-v3-int8-ov"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle for FastAPI."""
    mid = os.environ.get("MODEL_ID", DEFAULT_MODEL_ID)
    load_model_by_id(mid)
    if IDLE_TIMEOUT > 0:
        log.info(f"VRAM auto-release enabled: model unloads after {IDLE_TIMEOUT}s idle")
    else:
        log.info("VRAM auto-release disabled (IDLE_TIMEOUT=0)")
    log.info(f"Preprocess mode: {PREPROCESS_MODE}"
             f"{f' (model={VOCAL_SEP_MODEL})' if PREPROCESS_MODE == 'vocal_sep' else ''}")
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

# Silero VAD for filtering non-speech audio (BGM, effects, silence)
# before sending to Whisper — prevents hallucination on non-speech segments.
vad_model = SileroVAD(16000)

# Preprocessing mode: 'adaptive' (BGM detect + lightweight filter), 'vocal_sep' (MDX-Net),
# or 'none' (raw VAD only). Backwards compat: ENABLE_VOCAL_SEP=0 → 'none'.
PREPROCESS_MODE = os.environ.get("PREPROCESS_MODE", "adaptive")
if os.environ.get("ENABLE_VOCAL_SEP") == "0" and "PREPROCESS_MODE" not in os.environ:
    PREPROCESS_MODE = "none"

# Base VAD threshold for media content. Lower = more sensitive to speech.
# Default 0.20 is tuned for anime/TV/movie with continuous BGM.
# False positives from low threshold are handled by hallucination filtering.
VAD_BASE_THRESHOLD = float(os.environ.get("VAD_BASE_THRESHOLD", "0.20"))

# Vocal separation via MDX-Net ONNX (torch-free, lazy loaded) — used when PREPROCESS_MODE=vocal_sep
ENABLE_VOCAL_SEP = PREPROCESS_MODE == "vocal_sep"
VOCAL_SEP_MODEL = os.environ.get("VOCAL_SEP_MODEL", "UVR_MDXNET_KARA_2.onnx")
VOCAL_SEP_MODEL_URL = os.environ.get("VOCAL_SEP_MODEL_URL",
    "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/")
MODEL_CACHE_DIR = os.environ.get("MODEL_CACHE_DIR",
    "/root/.cache/huggingface/audio-separator-models")
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
    re.compile(r'^\w{1,2}$'),                        # 1-2 char: "me", "a", "I"
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
    if len(t) <= 4 and duration < 1.0:
        return True

    # Sub-0.3s is too short for real speech
    if duration < 0.3:
        return True

    return False


# ---------------------------------------------------------------------------
# Adaptive audio preprocessing (BGM detection + lightweight filtering)
# ---------------------------------------------------------------------------

def detect_bgm_level(audio: np.ndarray, sr: int = 16000) -> str:
    """Detect background music level using spectral energy analysis.

    Analyzes sub-band energy ratio and spectral flatness to classify audio as
    'clean' (speech only), 'light' (some background), or 'heavy' (music/BGM).

    Processes one 1-second window every 5 seconds — < 1s for any audio length.
    """
    window_size = sr  # 1 second
    hop = sr * 5      # every 5 seconds

    low_energy_ratios = []
    spectral_flatness_values = []

    for start in range(0, len(audio) - window_size, hop):
        chunk = audio[start:start + window_size]

        # Skip near-silent chunks (no useful spectral info)
        if np.max(np.abs(chunk)) < 0.01:
            continue

        spectrum = np.abs(np.fft.rfft(chunk))
        freqs = np.fft.rfftfreq(len(chunk), 1.0 / sr)

        # Low-frequency energy ratio (< 300Hz vs total)
        low_mask = freqs < 300
        low_energy = np.sum(spectrum[low_mask] ** 2)
        total_energy = np.sum(spectrum ** 2) + 1e-10
        low_energy_ratios.append(low_energy / total_energy)

        # Spectral flatness: geometric mean / arithmetic mean
        # Low flatness = tonal/harmonic (music), high flatness = noise-like (speech)
        log_spectrum = np.log(spectrum + 1e-10)
        geo_mean = np.exp(np.mean(log_spectrum))
        arith_mean = np.mean(spectrum) + 1e-10
        spectral_flatness_values.append(geo_mean / arith_mean)

    if not low_energy_ratios:
        return 'clean'

    avg_low_ratio = np.mean(low_energy_ratios)
    avg_flatness = np.mean(spectral_flatness_values)

    if avg_low_ratio > 0.35 and avg_flatness < 0.35:
        level = 'heavy'
    elif avg_low_ratio > 0.15 or avg_flatness < 0.50:
        level = 'light'
    else:
        level = 'clean'

    log.info(f"[adaptive] BGM level: {level} "
             f"(low_freq_ratio={avg_low_ratio:.3f}, flatness={avg_flatness:.3f})")
    return level


def apply_highpass(audio: np.ndarray, cutoff: int = 200,
                   sr: int = 16000, order: int = 4) -> np.ndarray:
    """Apply Butterworth highpass filter to attenuate low-frequency BGM.

    Only used for VAD preprocessing — Whisper always receives original audio.
    """
    nyq = sr / 2
    sos = butter(order, cutoff / nyq, btype='high', output='sos')
    return sosfilt(sos, audio).astype(np.float32)


def apply_light_denoise(audio: np.ndarray, sr: int = 16000) -> np.ndarray:
    """Light spectral subtraction for VAD improvement.

    Estimates noise from the quietest 10% of frames and subtracts it.
    Only used for VAD preprocessing — Whisper always receives original audio.
    """
    n_fft = 512
    hop_length = 128

    f, t, Zxx = scipy.signal.stft(audio, fs=sr, nperseg=n_fft,
                                    noverlap=n_fft - hop_length)
    magnitude = np.abs(Zxx)
    phase = np.angle(Zxx)

    # Estimate noise floor from bottom 10% energy frames
    frame_energy = np.sum(magnitude ** 2, axis=0)
    noise_threshold = np.percentile(frame_energy, 10)
    noise_frames = magnitude[:, frame_energy <= noise_threshold]
    if noise_frames.shape[1] == 0:
        return audio  # no quiet frames found, skip denoising
    noise_estimate = np.mean(noise_frames, axis=1, keepdims=True)

    # Spectral subtraction with flooring (preserve 10% of original to avoid artifacts)
    clean_magnitude = np.maximum(magnitude - noise_estimate * 1.5, magnitude * 0.1)

    _, denoised = scipy.signal.istft(clean_magnitude * np.exp(1j * phase),
                                      fs=sr, nperseg=n_fft,
                                      noverlap=n_fft - hop_length)

    return denoised.astype(np.float32)


# ---------------------------------------------------------------------------
# Vocal separation (MDX-Net ONNX, torch-free) — PREPROCESS_MODE=vocal_sep only
# ---------------------------------------------------------------------------

def _ensure_model_downloaded() -> str:
    """Download the ONNX model if not cached. Returns path to model file."""
    os.makedirs(MODEL_CACHE_DIR, exist_ok=True)
    model_path = os.path.join(MODEL_CACHE_DIR, VOCAL_SEP_MODEL)
    if os.path.exists(model_path):
        return model_path

    url = VOCAL_SEP_MODEL_URL + VOCAL_SEP_MODEL
    log.info(f"Downloading vocal separation model: {url}")
    resp = requests.get(url, stream=True, timeout=300)
    resp.raise_for_status()
    tmp_path = model_path + ".tmp"
    total = int(resp.headers.get('content-length', 0))
    downloaded = 0
    with open(tmp_path, 'wb') as f:
        for chunk in resp.iter_content(chunk_size=8192):
            f.write(chunk)
            downloaded += len(chunk)
            if total > 0 and downloaded % (1024 * 1024) < 8192:
                log.info(f"  {downloaded / 1024 / 1024:.1f} / {total / 1024 / 1024:.1f} MB")
    os.rename(tmp_path, model_path)
    log.info(f"Model downloaded: {model_path} ({downloaded / 1024 / 1024:.1f} MB)")
    return model_path


def vocal_separate(audio_16k: np.ndarray) -> np.ndarray:
    """Extract vocals from 16kHz mono audio using MDX-Net ONNX model.

    Args:
        audio_16k: 16kHz mono float32 numpy array
    Returns:
        vocals_16k: 16kHz mono float32 numpy array (vocals only)
    """
    global ENABLE_VOCAL_SEP

    try:
        model_path = _ensure_model_downloaded()
    except Exception as e:
        log.error(f"Model download failed: {e}. Disabling vocal separation.")
        ENABLE_VOCAL_SEP = False
        raise

    from vocal_separator import separate_vocals

    with _vocal_sep_lock:
        t0 = time.time()
        vocals = separate_vocals(audio_16k, model_path)
        elapsed = time.time() - t0

    log.info(f"Vocal separation done in {elapsed:.1f}s "
             f"({len(audio_16k)/16000:.1f}s audio, model={VOCAL_SEP_MODEL})")

    return vocals


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

            # Filter known Whisper hallucination patterns
            chunk_duration = abs_end - abs_start
            if is_hallucination(text, chunk_duration):
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

    PREPROCESS_MODE controls preprocessing strategy:
      'adaptive' (default): BGM detection + lightweight filtering for VAD accuracy
      'vocal_sep': MDX-Net ONNX vocal separation (slow but best for heavy BGM)
      'raw': No VAD/preprocessing — full audio to Whisper (baseline measurement)
      'none': Raw VAD + silence replacement (legacy)
    """
    if PREPROCESS_MODE == "vocal_sep":
        return _run_inference_vocal_sep(audio, language)
    elif PREPROCESS_MODE == "adaptive":
        return _run_inference_adaptive(audio, language)
    elif PREPROCESS_MODE == "raw":
        return _run_inference_raw(audio, language)
    else:
        return _run_inference_legacy(audio, language)


def _run_inference_adaptive(audio: np.ndarray, language: str = ""):
    """Adaptive pipeline: fast BGM detection + lightweight VAD preprocessing.

    1. Detect BGM level via spectral analysis (< 1s)
    2. Apply appropriate lightweight filter for VAD accuracy
    3. Run VAD on filtered audio to find speech segments
    4. Run per-segment whisper inference on ORIGINAL audio (quality preserved)
    """
    t0 = time.time()

    # Step 1: Detect BGM presence
    bgm_level = detect_bgm_level(audio)

    # Step 2: Preprocess for VAD only (Whisper always gets original audio)
    # Media-first approach: all input is movies/TV/anime with BGM/SFX,
    # so always apply at least a mild highpass filter.
    # Preprocessing removes BGM interference → threshold stays low for speech detection.
    if bgm_level == 'heavy':
        vad_audio = apply_highpass(audio, cutoff=250)
        vad_audio = apply_light_denoise(vad_audio)
        vad_threshold = VAD_BASE_THRESHOLD       # 0.20
        min_silence = 300   # short silence tolerance for rapid dialogue over heavy BGM
    elif bgm_level == 'light':
        vad_audio = apply_highpass(audio, cutoff=200)
        vad_threshold = VAD_BASE_THRESHOLD       # 0.20
        min_silence = 400
    else:  # clean (rare for media, but possible for interviews/narration)
        vad_audio = apply_highpass(audio, cutoff=150)
        vad_threshold = VAD_BASE_THRESHOLD + 0.10  # 0.30 — less sensitive for clean audio
        min_silence = 500

    preprocess_time = time.time() - t0
    log.info(f"[adaptive] Preprocessing: {preprocess_time:.2f}s "
             f"(bgm={bgm_level}, vad_threshold={vad_threshold})")

    # Step 3: VAD on preprocessed audio
    # Lower min thresholds for media content: short interjections, rapid dialogue
    speech_segments = vad_speech_timestamps(
        vad_audio, threshold=vad_threshold,
        min_speech_ms=150, min_silence_ms=min_silence
    )
    total_speech = sum(s['end'] - s['start'] for s in speech_segments) / 16000
    log.info(f"VAD: {len(speech_segments)} raw segments, "
             f"{total_speech:.1f}s speech / {len(audio)/16000:.1f}s total")

    if not speech_segments:
        log.info("No speech detected, skipping inference")
        _schedule_idle_unload()
        return [], "", 0.0

    # Step 4: Merge close segments (wider gap for scene transitions, keep short segments)
    merged = merge_segments(speech_segments, gap_threshold_s=3.0, min_duration_s=0.3)
    merged_speech = sum((s['end'] - s['start']) / 16000 for s in merged)
    log.info(f"Merged: {len(merged)} segments, {merged_speech:.1f}s total")

    # Step 5: Per-segment whisper inference on ORIGINAL audio
    all_chunks, full_text, inference_time = run_segment_inference(
        audio, merged, language
    )

    total_time = preprocess_time + inference_time
    log.info(f"Pipeline complete: preprocess={preprocess_time:.1f}s, "
             f"inference={inference_time:.1f}s, total={total_time:.1f}s, "
             f"{len(all_chunks)} chunks")

    return all_chunks, full_text, total_time


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


def _run_inference_raw(audio: np.ndarray, language: str = ""):
    """Raw baseline: no VAD, no preprocessing, just Whisper on full audio.

    Used for measuring baseline subtitle output without any filtering.
    Set PREPROCESS_MODE=raw to use this mode.
    """
    ensure_model_loaded()

    config = pipeline.get_generation_config()
    config.return_timestamps = True
    config.task = "transcribe"
    if language and language != "auto":
        config.language = f"<|{language}|>"

    log.info(f"[raw] Full audio inference: {len(audio)/16000:.1f}s, "
             f"model={model_id_str}, language={language or 'auto'}")

    t0 = time.time()
    result = pipeline.generate(audio, config)
    elapsed = time.time() - t0

    chunks = getattr(result, "chunks", [])
    full_text = "".join(c.text for c in chunks).strip() if chunks else str(result)

    log.info(f"[raw] Done: {len(chunks)} chunks, {len(full_text)} chars in {elapsed:.1f}s")
    for i, c in enumerate(chunks[:5]):
        log.info(f"  chunk[{i}]: [{c.start_ts:.1f}-{c.end_ts:.1f}] {c.text.strip()}")

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
        "preprocess_mode": PREPROCESS_MODE,
        "vocal_sep_model": VOCAL_SEP_MODEL if PREPROCESS_MODE == "vocal_sep" else None,
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
