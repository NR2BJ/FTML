"""Qwen 인식은 Intel GPU, 일본어/한국어 단어 정렬은 공식 CPU 구현을 사용한다."""

import hashlib
import json
import logging
import math
import os
from pathlib import Path
import subprocess
import shutil
import tempfile
import time
from types import SimpleNamespace
from difflib import SequenceMatcher


MODELS = {"Qwen/Qwen3-ASR-1.7B", "Qwen/Qwen3-ASR-0.6B"}
MODEL_REVISIONS = {
    "Qwen/Qwen3-ASR-1.7B": "7278e1e70fe206f11671096ffdd38061171dd6e5",
    "Qwen/Qwen3-ASR-0.6B": "5eb144179a02acc5e5ba31e748d22b0cf3e303b0",
}
ALIGNER = "Qwen/Qwen3-ForcedAligner-0.6B"
ALIGNER_REVISION = "c7cbfc2048c462b0d63a45797104fc9db3ad62b7"
LANGUAGES = {"ja": "Japanese", "ko": "Korean", "en": "English", "zh": "Chinese",
             "fr": "French", "de": "German", "es": "Spanish", "it": "Italian",
             "pt": "Portuguese", "ru": "Russian", "yue": "Cantonese"}
log = logging.getLogger("whisper")


def prepare_model(model_id, cancel=None):
    if model_id not in MODELS:
        raise ValueError("지원하지 않는 Qwen 모델입니다")
    revision = os.environ.get("QWEN_MODEL_REVISION") or MODEL_REVISIONS[model_id]
    key = hashlib.sha256((model_id + revision + "int8-v1").encode()).hexdigest()[:20]
    root = Path(os.environ.get("HF_HOME", str(Path.home() / ".cache/huggingface"))) / "ftml-openvino"
    root.mkdir(parents=True, exist_ok=True)
    destination = root / key
    if (destination / "ftml-ready.json").is_file():
        return destination
    # 불완전한 변환 결과는 다음 실행에서 정상 모델로 취급하지 않는다.
    with tempfile.TemporaryDirectory(prefix="export-", dir=root) as temp:
        log.info("Qwen 최초 준비: %s INT8 (다운로드/변환에 시간이 걸립니다)", model_id)
        from huggingface_hub import snapshot_download
        source = snapshot_download(model_id, revision=revision)
        if cancel is not None and cancel.is_set():
            raise InterruptedError("Transcription cancelled")
        exporter = shutil.which("optimum-cli")
        if not exporter:
            raise RuntimeError("Qwen 변환 도구 optimum-cli가 설치되지 않았습니다")
        command = [
            exporter, "export", "openvino", "--model", source,
            "--task", "automatic-speech-recognition-with-past",
            "--weight-format", "int8", "--trust-remote-code", temp,
        ]
        process = subprocess.Popen(command)
        try:
            deadline = time.monotonic()+3600
            while process.poll() is None:
                if cancel is not None and cancel.is_set():
                    raise InterruptedError("Transcription cancelled")
                if time.monotonic() > deadline:
                    raise TimeoutError("Qwen 변환 시간이 초과되었습니다")
                time.sleep(0.25)
            if process.returncode:
                raise RuntimeError("Qwen 모델 변환에 실패했습니다. 추출 서버 로그를 확인해 주세요")
        finally:
            if process.poll() is None:
                process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        path = Path(temp)
        if not (path / "config.json").is_file() or not list(path.glob("*.xml")):
            raise RuntimeError("Qwen 변환 결과가 불완전합니다")
        (path / "ftml-ready.json").write_text(json.dumps({"model": model_id, "revision": revision, "source_revision":Path(source).name}), encoding="utf-8")
        path.rename(destination)
    return destination


class QwenPipeline:
    chunk_seconds = 30

    def __init__(self, model_id, device, cancel=None):
        import openvino_genai
        import torch
        from qwen_asr import Qwen3ForcedAligner
        if not hasattr(openvino_genai, "ASRPipeline"):
            raise RuntimeError("이 OpenVINO 버전은 Qwen ASRPipeline을 지원하지 않습니다")
        model_path = prepare_model(model_id, cancel)
        self.asr = openvino_genai.ASRPipeline(str(model_path), device)
        torch.set_num_threads(max(1, int(os.environ.get("QWEN_ALIGNER_THREADS", "4"))))
        # 공식 OpenVINO 정렬의 일본어/한국어 분절 제한을 우회한다.
        self.aligner = Qwen3ForcedAligner.from_pretrained(
            ALIGNER, device_map="cpu", dtype=torch.float32,
            revision=os.environ.get("QWEN_ALIGNER_REVISION") or ALIGNER_REVISION,
        )
        self.detected_language = ""
        self.collapsed_words = 0

    def get_generation_config(self):
        return SimpleNamespace(language="", context="")

    def generate(self, audio, config):
        language = getattr(config, "language", "").replace("<|", "").replace("|>", "")
        language = LANGUAGES.get(language, language)
        options = {"context": getattr(config, "context", ""), "max_new_tokens": 1024,
                   "do_sample": False}
        if language and language != "auto":
            options["language"] = language
        result = self.asr.generate(audio.tolist(), **options)
        text = result.texts[0].strip() if result.texts else ""
        if not any(char.isalnum() for char in text):
            return SimpleNamespace(chunks=[], words=[])
        detected = (getattr(result, "languages", []) or [language])[0] or language
        supported = {value.lower() for value in LANGUAGES.values()}
        if detected.lower() not in supported:
            raise ValueError("Qwen 시간 정렬 언어를 확인하지 못했습니다. 음성 언어를 직접 선택해 주세요")
        self.detected_language = detected
        return self._align(audio, text, detected)

    def _align(self, audio, text, detected):
        aligned = self.aligner.align(audio=(audio, 16000), text=text, language=detected)[0]
        words = [{"word": item.text, "start_ts": item.start_time, "end_ts": item.end_time} for item in aligned]
        words, collapsed = normalize_aligned_words(words, text, len(audio)/16000)
        self.collapsed_words = getattr(self, "collapsed_words", 0) + collapsed
        segment = {"text": text, "start_ts": 0, "end_ts": len(audio)/16000}
        return SimpleNamespace(chunks=[segment], words=words)

    def align_reference(self, audio, text, language, original=None):
        if original is None:
            if len(audio) > self.chunk_seconds*16000:
                raise ValueError("긴 가사 구간은 먼저 추출한 원문과 함께 정렬해야 합니다")
            recognized = self.generate(audio, SimpleNamespace(language=language, context=""))
            original = "".join(c["text"] for c in recognized.chunks)
        canonical = lambda value: "".join(c.lower() for c in value if c.isalnum())
        expected, heard = canonical(text), canonical(original)
        # 전체판/다른 회차/모델이 듣지 못한 가사를 억지로 음성에 끼워 맞추지 않는다.
        if not heard or SequenceMatcher(None, expected, heard, autojunk=False).ratio() < 0.72:
            raise ValueError("참고 가사와 실제 인식 내용이 충분히 일치하지 않습니다. TV판 구간과 가사를 확인해 주세요")
        return self._align(audio, text, LANGUAGES.get(language, language))


def normalize_aligned_words(words, text, duration):
    canonical = lambda value: "".join(c.lower() for c in value if c.isalnum())
    message = "Qwen 단어 시각 정렬이 불확실합니다. 기존 자막은 유지되며 Whisper로 비교할 수 있습니다"
    if not words or canonical("".join(w["word"] for w in words)) != canonical(text):
        raise ValueError(message)
    for word in words:
        start, end = word["start_ts"], word["end_ts"]
        if not math.isfinite(start) or not math.isfinite(end) or not 0 <= start <= end <= duration+0.1 or start >= duration:
            raise ValueError(message)
        word["end_ts"] = min(end, duration)
    if not any(w["end_ts"] > w["start_ts"] for w in words):
        raise ValueError(message)
    result, collapsed, index = [], sum(w["start_ts"] == w["end_ts"] for w in words), 0
    while index < len(words):
        word = dict(words[index])
        if word["end_ts"] == word["start_ts"]:
            # 공식 정렬기의 반복 시각은 인접 단어에만 흡수한다. 먼 무음을 메우지 않는다.
            following = words[index+1] if index+1 < len(words) else None
            if following and word["start_ts"] <= following["start_ts"] <= word["end_ts"]+0.5:
                words[index+1] = {**following, "word": word["word"]+following["word"], "start_ts":word["start_ts"]}
            elif result and result[-1]["end_ts"] <= word["start_ts"] <= result[-1]["end_ts"]+0.5:
                result[-1]["word"] += word["word"]
                result[-1]["end_ts"] = word["start_ts"]
            else:
                # 고정한 공식 모델의 시각 해상도는 80ms다. 고립된 단어는 한 칸만
                # 추정하고 진단에 남긴다. 다음 대사까지 수초간 늘려 표시하지 않는다.
                word["end_ts"] = min(word["start_ts"]+0.08, duration)
                if following:
                    word["end_ts"] = min(word["end_ts"], following["start_ts"])
                if word["end_ts"] <= word["start_ts"] or (result and word["start_ts"] < result[-1]["end_ts"]):
                    raise ValueError(message)
                result.append(word)
        elif result and word["start_ts"] < result[-1]["end_ts"]:
            raise ValueError(message)
        else:
            result.append(word)
        index += 1
    return result, collapsed
