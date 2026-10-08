"""Timestamp-preserving subtitle processing, independent of inference libraries."""

import math


def timed_words_to_chunks(words, segments, offset=0, total_duration=None):
    """Whisper 자체 단어 시각으로 묶되 원문 누락/불일치 시 문장 시각을 유지한다."""
    fallback = normalize_chunks(segments, offset, total_duration)
    if not words:
        return fallback
    timed = []
    for word in words:
        get = word.get if isinstance(word, dict) else lambda key, default=None: getattr(word, key, default)
        text = str(get("word", get("text", "")) or "")
        try:
            start, end = float(get("start_ts")), float(get("end_ts"))
        except (TypeError, ValueError):
            return fallback
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end < start:
            return fallback
        if timed and start < timed[-1]["start_ts"]:
            return fallback
        if end == start:
            if timed and not any(c.isalnum() for c in text):
                timed[-1]["text"] += text
                continue
            return fallback
        timed.append({"text": text, "start_ts": start, "end_ts": end})
    canonical = lambda text: "".join(c for c in text if c.isalnum())
    if canonical("".join(w["text"] for w in timed)) != canonical("".join(c["text"] for c in fallback)):
        return fallback
    result, current = [], None
    for word in timed:
        if current and (word["start_ts"] - current["end_ts"] >= 0.45
                        or word["end_ts"] - current["start_ts"] > 6
                        or len(current["text"] + word["text"]) > 56):
            result.append(current)
            current = None
        if current is None:
            current = dict(word)
        else:
            current["text"] += word["text"]
            current["end_ts"] = max(current["end_ts"], word["end_ts"])
        if current["text"].rstrip().endswith(("。", "！", "？", ".", "!", "?")):
            result.append(current)
            current = None
    if current:
        result.append(current)
    return normalize_chunks(result, offset, total_duration)


def format_ts(seconds):
    milliseconds = max(0, round(seconds * 1000))
    hours, milliseconds = divmod(milliseconds, 3600000)
    minutes, milliseconds = divmod(milliseconds, 60000)
    seconds, milliseconds = divmod(milliseconds, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{milliseconds:03d}"


def is_hallucination(text, duration=0):
    # Text alone cannot distinguish a real greeting/reply from a hallucination.
    return not any(char.isalnum() for char in text)


def normalize_chunks(chunks, offset=0, total_duration=None):
    result = []
    for chunk in chunks:
        get = chunk.get if isinstance(chunk, dict) else lambda key, default=None: getattr(chunk, key, default)
        text = str(get("text", "") or "").strip()
        try:
            start = float(get("start_ts")) + offset
            end = float(get("end_ts")) + offset
        except (TypeError, ValueError):
            continue
        if not math.isfinite(start) or not math.isfinite(end):
            continue
        start = max(0, start)
        if total_duration is not None:
            end = min(end, total_duration)
        if end <= start or is_hallucination(text, end-start):
            continue
        result.append({"text": text, "start_ts": start, "end_ts": end})
    return sorted(result, key=lambda cue: (cue["start_ts"], cue["end_ts"]))


def merge_chunks(existing, incoming):
    """Compare only separate inference passes; keep repeated replies within a pass."""
    result = list(existing)
    for cue in incoming:
        duplicate = False
        for previous in reversed(existing):
            if previous["text"] != cue["text"]:
                continue
            overlap = min(previous["end_ts"], cue["end_ts"]) - max(previous["start_ts"], cue["start_ts"])
            shortest = min(previous["end_ts"]-previous["start_ts"], cue["end_ts"]-cue["start_ts"])
            if overlap > 0 and overlap >= 0.7 * shortest:
                duplicate = True
                break
        if not duplicate:
            result.append(cue)
    return sorted(result, key=lambda cue: (cue["start_ts"], cue["end_ts"]))


def find_gaps(chunks, total_duration, threshold):
    gaps, end = [], 0.0
    for cue in sorted(chunks, key=lambda cue: cue["start_ts"]):
        if cue["start_ts"] - end > threshold:
            gaps.append((end, min(total_duration, cue["start_ts"])))
        end = max(end, cue["end_ts"])
    if total_duration - end > threshold:
        gaps.append((end, total_duration))
    return gaps


def chunks_to_vtt(chunks):
    lines = ["WEBVTT", ""]
    for index, cue in enumerate(normalize_chunks(chunks), 1):
        lines.extend([str(index), f'{format_ts(cue["start_ts"])} --> {format_ts(cue["end_ts"])}', cue["text"], ""])
    return "\n".join(lines)
