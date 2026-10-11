"""운영 결과를 덮지 않고 같은 PCM16 WAV로 모델별 추출을 비교한다."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import threading
import time
import sys

from subtitle_processing import chunks_to_vtt
from extraction_trace import TraceWriter
from timing_evaluation import write_private


def main():
    if sys.platform != "linux":
        raise SystemExit("모델 검사는 메모리를 제한한 Linux 컨테이너에서만 실행합니다")
    import server
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", help="16kHz PCM16 WAV")
    parser.add_argument("--model", default="Qwen/Qwen3-ASR-1.7B", choices=[server.DEFAULT_MODEL_ID, *server.QWEN_MODELS])
    parser.add_argument("--language", default="ja")
    parser.add_argument("--output", required=True)
    parser.add_argument("--observe-speech", action="store_true")
    parser.add_argument("--trace", action="store_true", help="단계별 원문/시각을 비공개 JSONL 파일로 기록")
    parser.add_argument("--evaluation-id", help="후처리 비교용 고정 결과도 저장할 때 사용할 고유 ID")
    parser.add_argument("--work-id", help="작품을 구분하는 비공개 ID")
    parser.add_argument("--split", choices=["development", "validation", "holdout"], default="development")
    args = parser.parse_args()
    if args.evaluation_id and (not args.trace or not args.work_id):
        parser.error("평가 자료 저장에는 --trace와 --work-id가 필요합니다")
    output = Path(args.output)
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    started = time.monotonic()
    trace = TraceWriter(output / "stages.jsonl") if args.trace else None
    try:
        with open(args.audio, "rb") as audio:
            audio_hash = hashlib.file_digest(audio, "sha256").hexdigest() if args.evaluation_id else None
            audio.seek(0)
            cues, text, elapsed, duration, diagnostics = server._run_upload(
                audio, args.language, threading.Event(), args.model, observe_speech=args.observe_speech, trace=trace)
    finally:
        if trace:
            trace.close()
    report = {"duration": duration, "processing_seconds_including_load": elapsed,
              "total_seconds":time.monotonic()-started, "cue_count": len(cues),
              "diagnostics":diagnostics, "cues":cues}
    with os.fdopen(os.open(output / "subtitles.vtt", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf-8") as stream:
        stream.write(chunks_to_vtt(cues))
    write_private(output / "report.json", report)
    if args.evaluation_id:
        from timing_experiment import snapshot_from_trace
        modules = ("server.py", "subtitle_processing.py", "qwen_pipeline.py", "qwen_alignment.py",
                   "qwen_context_alignment.py", "speech_observer.py", "japanese_timing.py", "acoustic_timing.py")
        code_hashes = {name: hashlib.sha256((Path(__file__).parent / name).read_bytes()).hexdigest() for name in modules}
        snapshot = snapshot_from_trace(output / "stages.jsonl", id=args.evaluation_id, work_id=args.work_id,
                                       split=args.split, language=args.language, duration=duration,
                                       engine="qwen" if args.model in server.QWEN_MODELS else "whisper",
                                       provenance={"model": args.model, "diagnostics": diagnostics,
                                                   "audio_sha256": audio_hash, "code_sha256": code_hashes})
        write_private(output / "evaluation-snapshot.json", snapshot)
    print(json.dumps({key:value for key,value in report.items() if key != "cues"},ensure_ascii=False))


if __name__ == "__main__":
    main()
