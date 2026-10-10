"""운영 결과를 덮지 않고 같은 PCM16 WAV로 모델별 추출을 비교한다."""

import argparse
import json
from pathlib import Path
import threading
import time

import server
from subtitle_processing import chunks_to_vtt


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", help="16kHz PCM16 WAV")
    parser.add_argument("--model", default="Qwen/Qwen3-ASR-1.7B")
    parser.add_argument("--language", default="ja")
    parser.add_argument("--output", required=True)
    parser.add_argument("--observe-speech", action="store_true")
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    with open(args.audio, "rb") as audio:
        cues, text, elapsed, duration, _, diagnostics = server._run_upload(
            audio, args.language, threading.Event(), args.model, observe_speech=args.observe_speech)
    report = {"duration": duration, "processing_seconds_including_load": elapsed,
              "total_seconds":time.monotonic()-started, "cue_count": len(cues),
              "diagnostics":diagnostics, "cues":cues}
    (output / "subtitles.vtt").write_text(chunks_to_vtt(cues), encoding="utf-8")
    (output / "report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps({key:value for key,value in report.items() if key != "cues"},ensure_ascii=False))
    print(text)


if __name__ == "__main__":
    main()
