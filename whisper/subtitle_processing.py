"""Timestamp-preserving subtitle processing, independent of inference libraries."""

import math
from difflib import SequenceMatcher


def timed_words_to_chunks(words, segments, offset=0, total_duration=None, *, engine="whisper"):
    """유효한 단어 시각은 보존하고 불일치한 원문 부분만 이웃 시각으로 제한한다."""
    fallback = normalize_chunks(segments, offset, total_duration)
    if not words:
        return fallback
    source = "".join(c["text"] for c in fallback)
    canonical = lambda text: "".join(c for c in text if c.isalnum())
    word_text, entries = "", []
    for word in words:
        get = word.get if isinstance(word, dict) else lambda key, default=None: getattr(word, key, default)
        text = str(get("word", get("text", "")) or "")
        key = canonical(text)
        try:
            start, end = float(get("start_ts")) + offset, float(get("end_ts")) + offset
        except (TypeError, ValueError):
            start, end = -1, -1
        entries.append((len(word_text), len(word_text)+len(key), start, end))
        word_text += key
    blocks = SequenceMatcher(None, canonical(source), word_text, autojunk=False).get_matching_blocks()
    result, timed, cursor = [], [], 0
    for segment in fallback:
        first_item = len(timed)
        text = segment["text"]
        letters = [i for i, char in enumerate(text) if char.isalnum()]
        anchors = []
        for a, b, start, end in entries:
            if a == b or not math.isfinite(start) or not math.isfinite(end) or end <= start:
                continue
            if start < segment["start_ts"]-0.1 or end > segment["end_ts"]+0.1:
                continue
            for block in blocks:
                if block.b <= a and b <= block.b+block.size:
                    left, right = block.a+a-block.b-cursor, block.a+b-block.b-cursor
                    if 0 <= left < right <= len(letters):
                        if not anchors or (left >= anchors[-1][1] and start >= anchors[-1][3]):
                            anchors.append((left, right, max(start, segment["start_ts"]), min(end, segment["end_ts"])))
                    break
        if not anchors:
            timed.append(dict(segment))
        else:
            # 시간 정렬이 실패한 부분만 남겨 원문을 누락하거나 임의로 바꾸지 않는다.
            position, previous_end = 0, segment["start_ts"]
            for left, right, start, end in anchors:
                char_start = letters[left]
                char_end = letters[right] if right < len(letters) else len(text)
                gap = text[position:char_start]
                if canonical(gap):
                    if start <= previous_end:
                        anchors = []
                        break
                    timed.append({"text": gap, "start_ts": previous_end, "end_ts": start})
                elif gap and timed and position > 0:
                    timed[-1]["text"] += gap
                prefix = gap if position == 0 and not canonical(gap) else ""
                timed.append({"text": prefix + text[char_start:char_end], "start_ts": start, "end_ts": end})
                position, previous_end = char_end, end
            tail = text[position:]
            if anchors and canonical(tail):
                if previous_end < segment["end_ts"]:
                    timed.append({"text": tail, "start_ts": previous_end, "end_ts": segment["end_ts"]})
                else:
                    anchors = []
            if not anchors:
                del timed[first_item:]
                timed.append(dict(segment))
        cursor += len(letters)
        # 모델이 나눈 발언 경계는 후처리에서 다시 합치지 않는다.
        result.extend(group_timed_words(timed[first_item:], total_duration,
                                        gap_threshold=0.65 if engine == "qwen" else 0.3))
    return normalize_chunks(result, total_duration=total_duration)


def group_timed_words(timed, total_duration=None, *, gap_threshold=0.3):
    result, current = [], None
    for word in timed:
        gap = word["start_ts"] - current["end_ts"] if current else 0
        # 길이 목표를 넘겨도 일본어의 단어 조각 한가운데를 먼저 자르지 않는다.
        boundary = bool(current and (gap >= 0.12 or current["text"].endswith((" ", "、", ",", ";", "；", ":", "："))
                                     or word["text"].startswith(" ")))
        length = len(current["text"] + word["text"]) if current else 0
        duration = word["end_ts"] - current["start_ts"] if current else 0
        if current and (word["start_ts"] < current["end_ts"]
                        or gap >= gap_threshold
                        or (gap >= 0.3 and current["end_ts"]-current["start_ts"] >= 0.4
                            and current["text"].rstrip().endswith(("、", ",", ";", "；", ":", "：")))
                        or (boundary and (duration > 6 or length > 56))
                        or duration > 12 or length > 112):
            result.append(current)
            current = None
        if current is None:
            current = dict(word)
        else:
            current["text"] += word["text"]
            current["end_ts"] = max(current["end_ts"], word["end_ts"])
        if current["text"].rstrip(' \t\n\"\'」』）)]').endswith(("。", "！", "？", ".", "!", "?")):
            result.append(current)
            current = None
    if current:
        result.append(current)
    return normalize_chunks(result, total_duration=total_duration)


def stabilize_short_cues(chunks, total_duration):
    """Qwen의 순간 표시만 완화한다. 시작을 당기거나 다음 발언을 덮지 않는다."""
    result = [dict(cue) for cue in chunks]
    previous_end = -math.inf
    for index, cue in enumerate(result):
        overlapping = previous_end > cue["start_ts"]
        previous_end = max(previous_end, cue["end_ts"])
        if cue["end_ts"] - cue["start_ts"] >= 0.65:
            continue
        # 겹친 화자의 자막은 그대로 둔다. 긴 무음을 채우지 않고 최대 0.55초만 연장한다.
        if overlapping:
            continue
        limit = total_duration
        if index+1 < len(result):
            limit = min(limit, result[index+1]["start_ts"] - 0.04)
        cue["end_ts"] = max(cue["end_ts"], min(cue["start_ts"] + 0.65, cue["end_ts"] + 0.55, limit))
    return result


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


def merge_chunks(existing, incoming, recovery=False):
    """Compare only separate inference passes; keep repeated replies within a pass."""
    result = list(existing)
    for cue in incoming:
        duplicate = False
        for previous in reversed(existing):
            overlap = min(previous["end_ts"], cue["end_ts"]) - max(previous["start_ts"], cue["start_ts"])
            # 빈 구간 재인식은 이미 있는 대사 위에 다른 문장을 추가하지 않는다.
            if recovery and overlap > 0.05:
                duplicate = True
                break
            if previous["text"] != cue["text"]:
                continue
            shortest = min(previous["end_ts"]-previous["start_ts"], cue["end_ts"]-cue["start_ts"])
            if overlap > 0 and overlap >= 0.7 * shortest:
                duplicate = True
                break
        if not duplicate:
            result.append(cue)
    return sorted(result, key=lambda cue: (cue["start_ts"], cue["end_ts"]))


def stitch_chunks(existing, incoming, seam):
    """겹쳐 인식한 창 사이의 소유권을 나눈다. 같은 추론 안의 겹친 화자는 보존한다."""
    if not existing:
        return incoming
    if not incoming:
        return existing
    overlaps = lambda cue, others: any(min(cue["end_ts"], c["end_ts"])-max(cue["start_ts"], c["start_ts"]) > 0.05 for c in others)
    before = [c for c in existing if (c["start_ts"]+c["end_ts"])/2 < seam]
    after = [c for c in incoming if (c["start_ts"]+c["end_ts"])/2 >= seam]
    # 한쪽 인식이 놓친 대사는 소유권 경계만으로 버리지 않는다.
    before += [c for c in incoming if (c["start_ts"]+c["end_ts"])/2 < seam and not overlaps(c, before)]
    after += [c for c in existing if (c["start_ts"]+c["end_ts"])/2 >= seam and not overlaps(c, after)]
    # 경계에 걸친 이전 문장이 있으면 새 창의 중복 부분은 이전 문장을 우선한다.
    boundary = max((c["end_ts"] for c in before), default=seam)
    result = list(before)
    for cue in after:
        if cue["end_ts"] <= boundary:
            continue
        cue = dict(cue)
        cue["start_ts"] = max(cue["start_ts"], boundary)
        result.append(cue)
    return normalize_chunks(result)


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
