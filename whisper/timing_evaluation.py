"""모델 없이 고정 원문 실험을 비교한다. 정답 없는 수치는 품질 점수가 아니다."""

import argparse
from bisect import bisect_right
from collections import Counter, defaultdict
from hashlib import sha256
import json
from itertools import zip_longest
import math
import os
from pathlib import Path
import statistics
import unicodedata


SCHEMA = 1
MAX_BYTES = 32 * 1024 * 1024
MAX_CUES = 20000


def compact(text):
    return "".join(c for c in unicodedata.normalize("NFC", text) if not c.isspace())


def transcript(cues):
    return compact("".join(c["text"] for c in cues))


def literal_transcript(cues):
    return unicodedata.normalize("NFC", "".join(c["text"] for c in cues))


def read_json(path):
    with open(path, "rb") as stream:
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("검사 파일이 32MiB 한도를 넘습니다")
    return json.loads(data)


def write_private(path, value):
    """이미 있는 검사 결과/심볼릭 링크는 덮어쓰지 않는다."""
    with os.fdopen(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, allow_nan=False, indent=2)


def validate_cues(cues, duration):
    if not isinstance(cues, list) or len(cues) > MAX_CUES:
        raise ValueError("자막 목록 또는 개수 한도가 잘못됐습니다")
    previous = -1
    for cue in cues:
        if not isinstance(cue.get("text"), str) or not compact(cue["text"]):
            raise ValueError("비어 있거나 잘못된 원문입니다")
        start, end = cue["start_ts"], cue["end_ts"]
        if (not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in (start, end))
                or not 0 <= start < end <= duration + 1e-6 or start < previous):
            raise ValueError("유한한 순서의 영상 범위 내 시각이 필요합니다")
        previous = start


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]


def summary(values):
    return {"count": len(values), "median": statistics.median(values) if values else None,
            "p95": percentile(values, .95), "maximum": max(values, default=None)}


def cue_ranges(cues):
    position, result = 0, []
    for cue in cues:
        end = position + len(compact(cue["text"]))
        result.append((position, end, cue))
        position = end
    return result


def indicators(cues, short_seconds=.4):
    durations = [c["end_ts"] - c["start_ts"] for c in cues]
    overlaps, repeats = [], []
    frontier = 0
    for index, cue in enumerate(cues):
        if cue["start_ts"] < frontier:
            overlaps.append(index)
        frontier = max(frontier, cue["end_ts"])
        if index and compact(cue["text"]) == compact(cues[index-1]["text"]) and cue["start_ts"]-cues[index-1]["end_ts"] < 1:
            repeats.append(index)
    return {
        "cue_count": len(cues), "duration_seconds": summary(durations),
        "short_cue_indices": [i for i, value in enumerate(durations) if value < short_seconds],
        "overlap_indices": overlaps, "adjacent_repeat_indices": repeats,
        "notice": "검토 후보일 뿐 오류 판정이 아닙니다. 짧은 답변과 겹친 화자는 정상일 수 있습니다.",
    }


def compare_boundaries(baseline, candidate):
    """같은 글자 경계만 비교한다. 글자마다 시각을 나눠 가짜 단어 시각을 만들지 않는다."""
    if transcript(baseline) != transcript(candidate):
        return {"same_text": False, "same_literal_text": False, "status": "text_changed", "changes": []}
    original_start = {a: cue["start_ts"] for a, _, cue in cue_ranges(baseline)}
    original_end = {b: cue["end_ts"] for _, b, cue in cue_ranges(baseline)}
    changes, start_deltas, end_deltas = [], [], []
    for index, (a, b, cue) in enumerate(cue_ranges(candidate)):
        start = cue["start_ts"]-original_start[a] if a in original_start else None
        end = cue["end_ts"]-original_end[b] if b in original_end else None
        if start is not None:
            start_deltas.append(start)
        if end is not None:
            end_deltas.append(end)
        if start is None or end is None or abs(start) > .001 or abs(end) > .001:
            changes.append({"cue": index, "start_delta": start, "end_delta": end,
                            "new_boundary": start is None or end is None})
    return {"same_text": True, "same_literal_text": literal_transcript(baseline) == literal_transcript(candidate),
            "status": "compared", "changes": changes,
            "shared_starts": len(start_deltas), "shared_ends": len(end_deltas),
            "earlier_start_seconds": summary([-d for d in start_deltas if d < 0]),
            "later_start_seconds": summary([d for d in start_deltas if d > 0]),
            "shorter_end_seconds": summary([-d for d in end_deltas if d < 0])}


def reference_metrics(cues, reference, duration):
    if reference is None:
        return {"status": "no_reference", "quality_verdict": "unverified"}
    if reference.get("verified_by") != "human" or not reference.get("annotator"):
        raise ValueError("정답 채점에는 사람이 검수한 자료와 검수자 표시가 필요합니다")
    units = reference["cues"]
    validate_cues(units, duration)
    if not units:
        raise ValueError("빈 정답은 채점할 수 없습니다")
    if transcript(cues) != transcript(units):
        return {"status": "reference_text_mismatch", "quality_verdict": "unverified",
                "notice": "원문이 달라 시각만의 비교가 불가능합니다. 맞는 일부만 골라 채점하지 않습니다."}
    ranges = cue_ranges(cues)
    ends = [b for _, b, _ in ranges]
    starts, finishes, internal_gaps = [], [], []
    early, late, cut, linger = [], [], [], []
    for index, (a, b, unit) in enumerate(cue_ranges(units)):
        left = bisect_right(ends, a)
        right = bisect_right(ends, b-1)
        covered = [c for _, _, c in ranges[left:right+1]]
        # 표시된 첫/끝 글자의 시각이다. 자막 내부의 단어 시각을 추정하지 않는다.
        actual_start, actual_end = covered[0]["start_ts"], covered[-1]["end_ts"]
        onset = unit.get("onset_range", [unit["start_ts"], unit["start_ts"]])
        offset = unit.get("offset_range", [unit["end_ts"], unit["end_ts"]])
        for interval in (onset, offset):
            if (len(interval) != 2 or not all(isinstance(v, (float, int)) and math.isfinite(v) for v in interval)
                    or not 0 <= interval[0] <= interval[1] <= duration):
                raise ValueError("정답의 허용 시각 범위가 잘못됐습니다")
        if not onset[0] <= unit["start_ts"] <= onset[1] or not offset[0] <= unit["end_ts"] <= offset[1]:
            raise ValueError("기준 발화 시각이 허용 범위 안에 있어야 합니다")
        starts.append(max(0, onset[0]-actual_start, actual_start-onset[1]))
        finishes.append(max(0, offset[0]-actual_end, actual_end-offset[1]))
        for collection, value in ((early, onset[0]-actual_start), (late, actual_start-onset[1]),
                                  (cut, offset[0]-actual_end), (linger, actual_end-offset[1])):
            if value > 1e-6:
                collection.append({"unit": index, "seconds": value})
        frontier, gap_seconds = covered[0]["end_ts"], 0
        for cue in covered[1:]:
            gap_seconds += max(0, cue["start_ts"]-frontier)
            frontier = max(frontier, cue["end_ts"])
        internal_gaps.append(gap_seconds)
    return {"status": "scored", "quality_verdict": "reference_metrics_only", "units": len(units),
            "start_error_seconds": summary(starts), "end_error_seconds": summary(finishes),
            "early_starts": early, "late_starts": late, "early_ends": cut, "late_ends": linger,
            "within_utterance_display_gaps_seconds": summary(internal_gaps)}


def evaluate_case(case):
    if case.get("schema_version") != SCHEMA:
        raise ValueError("지원하지 않는 검사 형식입니다")
    for field in ("id", "work_id", "engine", "language", "split"):
        if not isinstance(case.get(field), str) or not case[field]:
            raise ValueError(f"필수 검사 항목 누락: {field}")
    if case["split"] not in ("development", "validation", "holdout"):
        raise ValueError("검사 자료의 용도를 명시해야 합니다")
    duration = case["duration"]
    if not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 < duration <= 14400:
        raise ValueError("검사 영상 길이가 잘못됐습니다")
    variants = case["variants"]
    if not isinstance(variants, dict) or not 1 <= len(variants) <= 16:
        raise ValueError("비교 후보는 1~16개여야 합니다")
    baseline = variants[case["baseline"]]["cues"]
    for variant in variants.values():
        validate_cues(variant["cues"], duration)
    reference = case.get("reference")
    result = {k: case[k] for k in ("id", "work_id", "engine", "language", "split", "duration", "baseline")}
    result["recognition_sha256"] = sha256(transcript(baseline).encode()).hexdigest()
    result["provenance"] = case.get("provenance", {})
    result["variants"] = {}
    for name, variant in variants.items():
        cues = variant["cues"]
        source_hash = result["provenance"].get("source_transcript_sha256")
        literal_hash = result["provenance"].get("source_literal_sha256")
        result["variants"][name] = {"description": variant.get("description", ""),
                                     "source_text_preserved": (sha256(transcript(cues).encode()).hexdigest() == source_hash) if source_hash else None,
                                     "source_literal_preserved": (sha256(literal_transcript(cues).encode()).hexdigest() == literal_hash) if literal_hash else None,
                                     "indicators": indicators(cues),
                                     "comparison": compare_boundaries(baseline, cues),
                                     "reference": reference_metrics(cues, reference, duration)}
    return result


def review_candidates(case, original, limit=60):
    """청취할 위치만 고른다. 후보 수를 오류율로 해석하지 않는다."""
    queues = []
    for name, variant in case["variants"].items():
        marked = defaultdict(set)
        stats = variant["indicators"]
        for field in ("short_cue_indices", "overlap_indices", "adjacent_repeat_indices"):
            for index in stats[field]:
                marked[index].add(field)
        for change in variant["comparison"]["changes"]:
            if change["new_boundary"] or any(abs(change[k] or 0) >= .4 for k in ("start_delta", "end_delta")):
                marked[change["cue"]].add("boundary_changed")
        queue = []
        for index, reasons in sorted(marked.items()):
            cue = original["variants"][name]["cues"][index]
            queue.append({"variant": name, "cue": index, "reasons": sorted(reasons),
                          "start_ts": cue["start_ts"], "end_ts": cue["end_ts"],
                          "listen_start": max(0, cue["start_ts"]-1.5),
                          "listen_end": min(case["duration"], cue["end_ts"]+1.5)})
        queues.append(queue)
    # 한 후보가 검토 목록 전체를 차지하지 않도록 후보별 시간순 목록을 번갈아 뽑는다.
    result = [entry for row in zip_longest(*queues) for entry in row if entry is not None]
    return {"total": len(result), "selected": result[:limit], "selection": "round-robin chronological, not an error ranking"}


def evaluate(cases):
    if not cases or len(cases) > 200:
        raise ValueError("검사 자료는 1~200개여야 합니다")
    seen, assignments = set(), {}
    results = []
    for case in cases:
        key = case["id"]
        if key in seen:
            raise ValueError("검사 ID가 중복됩니다")
        seen.add(key)
        work, split = case["work_id"], case["split"]
        if work in assignments and assignments[work] != split:
            raise ValueError("같은 작품을 개선 자료와 독립 평가 자료로 나눌 수 없습니다")
        assignments[work] = split
        result = evaluate_case(case)
        result["review_candidates"] = review_candidates(result, case)
        results.append(result)
    strata = defaultdict(Counter)
    for case in results:
        key = "/".join(case[k] for k in ("split", "language", "engine"))
        strata[key]["cases"] += 1
        strata[key]["duration_seconds"] += case["duration"]
    return {"schema_version": SCHEMA, "quality_verdict": "not_automatically_decided",
            "notice": "검토 후보 감소는 정확도 향상이 아닙니다. 정답·미사용 작품 검증 없이 보정을 자동 채택하지 않습니다.",
            "text_comparison": "시각 대응은 NFC·공백 제외 글자를 사용합니다. 공백 포함 원문 보존도 별도로 확인합니다.",
            "thresholds": {"short_cue_seconds": .4, "repeat_neighbor_gap_seconds": 1},
            "strata": dict(strata), "cases": results}


def markdown_report(report):
    lines = ["# 자막 보정 비교", "", report["notice"], "", "| 자료 | 후보 | 자막 수 | 짧은 표시 후보 | 반복 후보 | 원문 유지(공백 제외) | 정답 채점 |",
             "| --- | --- | ---: | ---: | ---: | --- | --- |"]
    escape = lambda text: str(text).replace("|", "\\|").replace("\n", " ").replace("\r", " ")
    for case in report["cases"]:
        for name, item in case["variants"].items():
            indicators_ = item["indicators"]
            lines.append("| " + " | ".join(map(escape, (case["id"], name, indicators_["cue_count"],
                len(indicators_["short_cue_indices"]), len(indicators_["adjacent_repeat_indices"]),
                "예" if item["comparison"]["same_text"] else "아니요", item["reference"]["status"]))) + " |")
    lines += ["", "짧은 답변·반복 발언·겹친 화자는 정상일 수 있습니다. 위 수치는 오류 개수나 품질 순위가 아닙니다.",
              "구간과 변화량은 report.json에 기록했습니다. 정답이 없으면 선행 표시·조기 소멸의 개선 여부는 판정하지 않습니다."]
    return "\n".join(lines) + "\n"


def evaluate_files(paths):
    if not paths or len(paths) > 200 or sum(Path(path).stat().st_size for path in paths) > MAX_BYTES:
        raise ValueError("한 번의 비교 입력 합계는 32MiB 이하로 제한합니다")
    return evaluate([read_json(path) for path in paths])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cases", nargs="+")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    report = evaluate_files(args.cases)
    output = Path(args.output)
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    write_private(output / "report.json", report)
    with os.fdopen(os.open(output / "report.md", os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w", encoding="utf-8") as stream:
        stream.write(markdown_report(report))
    print(f"비교 완료: {len(report['cases'])}개 자료. 정답 없는 결과는 품질 미검증입니다.")


if __name__ == "__main__":
    main()
