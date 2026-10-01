"""Timestamp-preserving subtitle processing, independent of inference libraries."""

import math


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
