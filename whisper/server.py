"""
faster-whisper Flask wrapper
Exposes the same HTTP API as whisper.cpp's whisper-server
for drop-in compatibility with the Go backend client.

Endpoint: POST /inference
"""
import os
import io
import tempfile
from flask import Flask, request, jsonify
from faster_whisper import WhisperModel

app = Flask(__name__)

# Load model on startup
MODEL_SIZE = os.environ.get("WHISPER_MODEL", "large-v3")
MODEL_DIR = os.environ.get("WHISPER_MODEL_DIR", "/models")
DEVICE = os.environ.get("WHISPER_DEVICE", "cuda")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "float16")

print(f"Loading model: {MODEL_SIZE} from {MODEL_DIR} on {DEVICE} ({COMPUTE_TYPE})")
model = WhisperModel(
    MODEL_SIZE,
    device=DEVICE,
    compute_type=COMPUTE_TYPE,
    download_root=MODEL_DIR,
)
print("Model loaded successfully")


def format_timestamp(seconds: float) -> str:
    """Convert seconds to VTT timestamp format HH:MM:SS.mmm"""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{ms:03d}"


def segments_to_vtt(segments) -> str:
    """Convert faster-whisper segments to WebVTT format"""
    lines = ["WEBVTT", ""]
    for i, segment in enumerate(segments, 1):
        start = format_timestamp(segment.start)
        end = format_timestamp(segment.end)
        text = segment.text.strip()
        if text:
            lines.append(str(i))
            lines.append(f"{start} --> {end}")
            lines.append(text)
            lines.append("")
    return "\n".join(lines)


@app.route("/inference", methods=["POST"])
def inference():
    """Transcribe audio file to text/VTT"""
    if "file" not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files["file"]
    language = request.form.get("language", None)
    response_format = request.form.get("response_format", "vtt")
    temperature = float(request.form.get("temperature", "0.0"))

    if language == "auto" or language == "":
        language = None

    # Save uploaded file temporarily
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        audio_file.save(tmp)
        tmp_path = tmp.name

    try:
        # Transcribe
        segments, info = model.transcribe(
            tmp_path,
            language=language,
            beam_size=5,
            temperature=temperature,
            vad_filter=True,
            vad_parameters=dict(
                min_silence_duration_ms=500,
            ),
        )

        # Collect segments (generator)
        segment_list = list(segments)

        detected_lang = info.language if info else (language or "unknown")

        if response_format == "vtt":
            vtt = segments_to_vtt(segment_list)
            return vtt, 200, {"Content-Type": "text/vtt; charset=utf-8"}
        else:
            # JSON response
            result = {
                "language": detected_lang,
                "segments": [
                    {
                        "start": s.start,
                        "end": s.end,
                        "text": s.text.strip(),
                    }
                    for s in segment_list
                ],
            }
            return jsonify(result)

    finally:
        os.unlink(tmp_path)


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "model": MODEL_SIZE})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8178"))
    app.run(host="0.0.0.0", port=port, debug=False)
