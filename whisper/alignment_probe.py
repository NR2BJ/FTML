"""Linux 격리 검사 전용. 다운로드 없이 원문/정렬 시각을 따로 기록한다."""

import argparse
import json
import os
from pathlib import Path
import sys
import wave


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["qwen-scores", "qwen-native", "whisper-native", "ctc-ja"])
    parser.add_argument("--inputs", required=True, help="WAV와 언어, 원문을 지정한 JSON 목록")
    parser.add_argument("--model-path", required=True, help="기존 모델의 로컬 경로")
    parser.add_argument("--output", required=True, help="새 결과 폴더")
    parser.add_argument("--device", default="GPU")
    args = parser.parse_args()
    if sys.platform != "linux":
        parser.error("실제 모델 검사는 메모리를 제한한 Linux 컨테이너에서만 실행합니다")
    for key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE"):
        if os.environ.get(key) != "1":
            parser.error("모델 다운로드를 막는 오프라인 설정이 필요합니다")
    if not Path(args.model_path).is_dir():
        parser.error("기존 모델 경로가 없습니다")
    sources = json.loads(Path(args.inputs).read_text())
    if not isinstance(sources, list) or not 1 <= len(sources) <= 12:
        parser.error("한 검사에서는 최대 12개의 짧은 구간만 비교합니다")
    for source in sources:
        with wave.open(source["audio"], "rb") as stream:
            if (stream.getframerate(), stream.getnchannels(), stream.getsampwidth()) != (16000, 1, 2):
                parser.error("입력은 16kHz 모노 PCM16 WAV여야 합니다")
            if not 0 < stream.getnframes() <= 30.01 * 16000:
                parser.error("각 입력은 30초 이하여야 합니다")
    output = Path(args.output)
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    import numpy as np
    if args.mode == "qwen-scores":
        import torch
        from qwen_asr import Qwen3ForcedAligner
        from alignment_scores import monotonic_timestamps
        torch.set_num_threads(2)
        torch.set_num_interop_threads(1)
        model = Qwen3ForcedAligner.from_pretrained(
            args.model_path, device_map="cpu", dtype=torch.float32, local_files_only=True)
    elif args.mode == "ctc-ja":
        import torch
        from transformers import AutoProcessor, AutoModelForCTC
        from ctc_alignment import align_ctc
        torch.set_num_threads(2)
        torch.set_num_interop_threads(1)
        processor = AutoProcessor.from_pretrained(args.model_path, local_files_only=True, trust_remote_code=False)
        model = AutoModelForCTC.from_pretrained(args.model_path, local_files_only=True, trust_remote_code=False).eval()
        vocab = processor.tokenizer.get_vocab()
    else:
        import openvino_genai
        model = (openvino_genai.ASRPipeline(args.model_path, args.device) if args.mode == "qwen-native"
                 else openvino_genai.WhisperPipeline(args.model_path, args.device, word_timestamps=True))
    for index, source in enumerate(sources):
        with wave.open(source["audio"], "rb") as stream:
            if (stream.getframerate(), stream.getnchannels(), stream.getsampwidth()) != (16000, 1, 2):
                raise ValueError("입력은 16kHz 모노 PCM16 WAV여야 합니다")
            # FFmpeg 재표본화 끝의 수 샘플만 제한한다. 앞부분/중간 무음은 손대지 않는다.
            frames = min(stream.getnframes(), 30 * 16000)
            audio = np.frombuffer(stream.readframes(frames), dtype="<i2").astype(np.float32) / 32768
        duration = len(audio) / 16000
        record = dict(source=source, duration=duration)
        if args.mode == "qwen-scores":
            captured = []
            def capture(module, inputs, kwargs, result):
                mask = kwargs["input_ids"][0] == model.timestamp_token_id
                captured.append(result.logits[0, mask].detach().float().cpu().numpy().copy())
            hook = model.model.thinker.register_forward_hook(capture, with_kwargs=True)
            try:
                aligned = model.align(audio=(audio, 16000), text=source["text"], language=source["language"])[0]
            finally:
                hook.remove()
            if len(captured) != 1 or len(captured[0]) != 2 * len(aligned):
                raise ValueError("단어와 원시 시각 점수의 개수가 다릅니다")
            tick = model.timestamp_segment_time / 1000
            record.update(tick_seconds=tick, words=[dict(word=w.text, start_ts=w.start_time, end_ts=w.end_time) for w in aligned])
            np.savez_compressed(output / f"{index}-scores.npz", logits=captured[0])
            record["candidates"] = {str(minimum): monotonic_timestamps(
                captured[0], duration, tick, minimum_word_ticks=minimum).tolist() for minimum in (0, 1)}
        elif args.mode == "ctc-ja":
            if source["language"] != "ja":
                raise ValueError("CTC 비교 입력은 일본어만 검증했습니다")
            inputs = processor(audio, sampling_rate=16000, return_tensors="pt")
            with torch.inference_mode():
                scores = model(**inputs).logits[0].float().log_softmax(-1).numpy()
            record["alignments"] = {}
            for engine, text in source["texts"].items():
                chars = [(i, char) for i, char in enumerate(text) if char.isalnum()]
                unknown = [(i, char) for i, char in chars if char not in vocab]
                if unknown:
                    record["alignments"][engine] = dict(error="unsupported_characters", characters=unknown)
                    continue
                try:
                    aligned = align_ctc(scores, [vocab[c] for _, c in chars], model.config.pad_token_id)
                    scale = duration / len(scores)
                    record["alignments"][engine] = [dict(char=char, source_index=i,
                        start_ts=point["start_frame"]*scale, end_ts=point["end_frame"]*scale,
                        score=point["mean_log_score"]) for (i, char), point in zip(chars, aligned)]
                except ValueError as exc:
                    record["alignments"][engine] = dict(error=str(exc))
        elif args.mode == "qwen-native":
            languages = {"ja": "Japanese", "ko": "Korean", "en": "English"}
            result = model.generate(audio.tolist(), context="", max_new_tokens=1024, do_sample=False,
                                    language=languages[source["language"]])
            record.update(texts=list(result.texts), languages=list(result.languages))
        else:
            results = {}
            for word_timing in (False, True):
                config = model.get_generation_config()
                config.task = "transcribe"
                config.language = f'<|{source["language"]}|>' if source["language"] != "auto" else None
                config.return_timestamps = True
                config.word_timestamps = word_timing
                result = model.generate(audio.tolist(), config)
                results[str(word_timing)] = dict(texts=list(result.texts),
                    segments=[dict(text=c.text, start_ts=c.start_ts, end_ts=c.end_ts) for c in result.chunks or []],
                    words=[dict(word=w.word, start_ts=w.start_ts, end_ts=w.end_ts) for w in getattr(result, "words", []) or []])
            record["results"] = results
        (output / f"{index}.json").write_text(json.dumps(record, ensure_ascii=False, indent=2))
        print(f"검사 {index+1}/{len(sources)} 저장", flush=True)


if __name__ == "__main__":
    main()
