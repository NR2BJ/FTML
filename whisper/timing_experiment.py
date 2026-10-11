"""고정된 추출 원문으로 후처리 제거 실험을 한다. 운영 설정/결과는 수정하지 않는다."""

import argparse
from copy import deepcopy
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import sys
import time
import wave

from acoustic_timing import japanese_text
from acoustic_timing import display_units
from speech_observer import refine_whisper_onsets, refine_whisper_prefixes
from subtitle_processing import group_timed_words, stabilize_short_cues
from timing_evaluation import MAX_BYTES, evaluate_case, literal_transcript, read_json, transcript, validate_cues, write_private


def snapshot_from_trace(path, **metadata):
    """완료된 전체 기록만 사용한다. 오래된 기록에 관측치가 없으면 추정하지 않는다."""
    wanted = {"before_speech_boundaries", "timing_experiment_context", "final"}
    records, size = {}, 0
    with open(path, "rb") as stream:
        while True:
            line = stream.readline(MAX_BYTES + 1)
            if not line:
                break
            size += len(line)
            if size > MAX_BYTES:
                raise ValueError("단계 기록이 너무 큽니다")
            value = json.loads(line)
            stage = value["stage"]
            if stage in wanted:
                if stage in records:
                    raise ValueError("여러 작업의 기록이 섞여 있습니다")
                records[stage] = value
    if records.keys() != wanted:
        raise ValueError("완료된 원문/관측/최종 기록이 모두 필요합니다")
    context = records["timing_experiment_context"]
    return dict(metadata, schema_version=1, source_stage="before_speech_boundaries",
                cues=records["before_speech_boundaries"]["cues"],
                speech_spans=context["speech_spans"], speech_boundaries_enabled=context["speech_boundaries_enabled"],
                display_policy=context.get("display_policy", "legacy"),
                acoustic_timing_enabled=context["acoustic_timing_enabled"], expected_current=records["final"]["cues"])


def compare_snapshot(snapshot, review=None, trim=None, *, display_review=None, supported_review=None):
    """review는 고정 원문을 받아 (새 시각, 진단)을 반환한다. 인식 모델을 호출하지 않는다."""
    source = snapshot["cues"]
    duration, engine = snapshot["duration"], snapshot["engine"]
    if engine not in ("whisper", "qwen") or snapshot.get("source_stage") != "before_speech_boundaries":
        raise ValueError("지원하는 추출기와 말소리 경계 보정 전 자료가 필요합니다")
    if not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 < duration <= 900:
        raise ValueError("각 비교 입력은 최대 15분입니다")
    validate_cues(source, duration)
    japanese = snapshot.get("acoustic_timing_enabled", True) and japanese_text(source, snapshot["language"])
    if japanese and review is None:
        raise ValueError("일본어 전체 제거 실험에는 별도 음향 대조가 필요합니다")
    spans = snapshot.get("speech_spans")
    speech_enabled = engine == "whisper" and snapshot.get("speech_boundaries_enabled", True)
    if speech_enabled:
        if spans is None:
            raise ValueError("말소리 경계 보정이 켜져 있으나 관측 자료가 없습니다")
        previous = -1
        for start, end in spans:
            if not all(math.isfinite(v) for v in (start, end)) or not 0 <= start < end <= duration or start < previous:
                raise ValueError("말소리 검출 시각이 잘못됐습니다")
            previous = end
    adjusted = deepcopy(source)
    diagnostics = {}
    if speech_enabled:
        adjusted, prefixes = refine_whisper_prefixes(adjusted, spans)
        adjusted, onsets = refine_whisper_onsets(adjusted, spans)
        diagnostics["speech"] = dict(prefixes=prefixes, onsets=onsets)

    def aligned(words, name):
        if not japanese:
            return deepcopy(words)
        candidate, details = review(deepcopy(words))
        validate_cues(candidate, duration)
        if literal_transcript(candidate) != literal_transcript(words):
            raise ValueError("음향 대조가 고정 원문을 변경했습니다")
        diagnostics[name] = details
        return candidate

    corrected = aligned(adjusted, "current")
    without_speech = aligned(source, "without_speech") if speech_enabled and adjusted != source else corrected

    def finish(words, hold=True):
        cues = group_timed_words(deepcopy(words), duration, gap_threshold=.65 if engine == "qwen" else .3)
        cues = [{k: v for k, v in cue.items() if not k.startswith("_")} for cue in cues]
        if engine == "qwen" and hold:
            cues = stabilize_short_cues(cues, duration)
        if trim is not None:
            cues = trim(cues)
        validate_cues(cues, duration)
        return cues

    variants = {
        "no_optional_timing": {"cues": finish(source), "description": "고정 원문에 말소리/음향 보정 없이 공통 묶기·표시만 적용"},
        "current": {"cues": finish(corrected), "description": "현재 말소리/일본어 음향 보정과 공통 표시 적용"},
    }
    if japanese:
        variants["without_acoustic"] = {"cues": finish(adjusted), "description": "일본어 음향 대조만 제거"}
    if speech_enabled:
        variants["without_speech"] = {"cues": finish(without_speech), "description": "말소리 경계 보정만 제거하고 음향 대조 재실행"}
    if engine == "qwen":
        variants["without_hold"] = {"cues": finish(corrected, False), "description": "현재 보정에서 짧은 자막 표시 연장만 제거"}
    for name, callback, description in (
        ("source_boundaries", display_review, "같은 채택 시각에 원래 발언 경계로 표시 묶기"),
        ("supported_boundaries", supported_review, "양쪽 끝이 확인된 이웃끼리만 처리 경계 제거"),
    ):
        if callback is None:
            continue
        units = callback()
        validate_cues(units, duration)
        if literal_transcript(units) != literal_transcript(adjusted):
            raise ValueError("표시 묶음 비교에서 원문이 바뀌었습니다")
        variants[name] = {"cues": finish(units), "description": description}
    result = {k: snapshot[k] for k in ("id", "work_id", "language", "split", "duration", "engine")}
    result.update(schema_version=1, baseline="no_optional_timing", variants=variants, diagnostics=diagnostics,
                  provenance={**snapshot.get("provenance", {}), "source_stage": snapshot["source_stage"],
                              "source_transcript_sha256": sha256(transcript(source).encode()).hexdigest(),
                              "source_literal_sha256": sha256(literal_transcript(source).encode()).hexdigest(),
                              "scope": "정렬·창 연결 뒤 후처리 비교입니다. Qwen 앞선 재정렬과 창 연결 자체의 제거 실험은 아닙니다.",
                              "digital_silence_trim": trim is not None})
    if "reference" in snapshot:
        result["reference"] = snapshot["reference"]
    if "expected_current" in snapshot:
        actual, expected = variants["current"]["cues"], snapshot["expected_current"]
        equal = (len(actual) == len(expected) and all(a["text"] == b["text"]
                 and abs(a["start_ts"]-b["start_ts"]) <= .002 and abs(a["end_ts"]-b["end_ts"]) <= .002
                 for a, b in zip(actual, expected)))
        if not equal:
            raise ValueError("실험의 현재 결과가 원래 완료 결과와 다릅니다. 설정/코드/모델을 확인하세요")
        result["provenance"]["production_replay"] = "matched_within_2ms"
    evaluate_case(result)
    return result


class WaveSource:
    def __init__(self, path, duration):
        self.stream = wave.open(str(path), "rb")
        if (self.stream.getnchannels(), self.stream.getsampwidth(), self.stream.getframerate(), self.stream.getcomptype()) != (1, 2, 16000, "NONE"):
            self.stream.close()
            raise ValueError("16kHz 모노 PCM16 WAV만 지원합니다")
        if abs(self.stream.getnframes()/16000-duration) > 1/16000:
            self.stream.close()
            raise ValueError("추출 자료와 음성 길이가 다릅니다")
        self.duration = duration

    def read(self, first, last):
        import numpy as np
        if first < 0 or last > self.stream.getnframes() or not 0 <= last-first <= 30*16000:
            raise ValueError("한 번에 최대 30초만 읽습니다")
        self.stream.setpos(first)
        return np.frombuffer(self.stream.readframes(last-first), dtype="<i2").astype(np.float32)/32768

    def trim(self, cues):
        import numpy as np
        result = []
        for cue in cues:
            start, end = int(cue["start_ts"]*16000), int(cue["end_ts"]*16000)
            if end-start > 30*16000:
                result.append(cue)
                continue
            nonzero = np.flatnonzero(self.read(start, end))
            if nonzero.size:
                cue = dict(cue)
                cue["start_ts"] = max(cue["start_ts"], (start+nonzero[0])/16000-.02)
                cue["end_ts"] = min(cue["end_ts"], (start+nonzero[-1]+1)/16000+.02)
                result.append(cue)
        return result


def main():
    if sys.platform != "linux":
        raise SystemExit("모델 비교는 메모리를 제한한 Linux 컨테이너에서만 실행합니다")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--acoustic-model-path")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if os.environ.get("HF_HUB_OFFLINE") != "1" or os.environ.get("TRANSFORMERS_OFFLINE") != "1":
        raise SystemExit("오프라인 검사 환경을 지정해야 합니다")
    snapshot = read_json(args.snapshot)
    if not isinstance(snapshot["duration"], (int, float)) or not 0 < snapshot["duration"] <= 900:
        raise SystemExit("검사 입력은 최대 15분입니다")
    if Path(args.output).exists():
        raise SystemExit("기존 검사 결과는 덮어쓰지 않습니다")
    validate_cues(snapshot["cues"], snapshot["duration"])
    audio = WaveSource(args.audio, snapshot["duration"])
    try:
        reviewer = None
        if snapshot.get("acoustic_timing_enabled", True) and japanese_text(snapshot["cues"], snapshot["language"]):
            if not args.acoustic_model_path or not Path(args.acoustic_model_path).is_dir():
                raise SystemExit("이미 설치된 음향 모델 경로가 필요합니다")
            from japanese_timing import JapaneseTiming
            reviewer = JapaneseTiming(args.acoustic_model_path)
        started = time.monotonic()
        resolved = []
        def trace(stage, **values):
            if stage == "acoustic_resolved" and not resolved:
                resolved.extend(deepcopy(values["proposals"]))
        def review(words):
            return reviewer.review(words, audio.read, snapshot["duration"], trace=trace,
                                   display_policy=snapshot.get("display_policy", "legacy"))
        result = compare_snapshot(snapshot, review if reviewer else None, audio.trim,
                                  display_review=(lambda: display_units(resolved, "source")) if reviewer else None,
                                  supported_review=(lambda: display_units(resolved, "supported")) if reviewer else None)
        result["provenance"]["comparison_seconds_excluding_load"] = time.monotonic()-started
        result["provenance"]["snapshot_sha256"] = sha256(Path(args.snapshot).read_bytes()).hexdigest()
        write_private(args.output, result)
    finally:
        audio.stream.close()
    print("비교 완료. 운영 자막과 설정은 변경하지 않았습니다.")


if __name__ == "__main__":
    main()
