"""Timestamp-preserving subtitle processing, independent of inference libraries."""

import math
from difflib import SequenceMatcher


def timed_words_to_chunks(words, segments, offset=0, total_duration=None, *, engine="whisper", word_output=False):
    """유효한 단어 시각은 보존하고 불일치한 원문 부분만 이웃 시각으로 제한한다."""
    fallback = normalize_chunks(segments, offset, total_duration)
    if not words:
        return [dict(cue, _segment=(offset, index)) for index, cue in enumerate(fallback)] if word_output else fallback
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
        entries.append((len(word_text), len(word_text)+len(key), start, end, bool(get("_timing_uncertain"))))
        word_text += key
    blocks = SequenceMatcher(None, canonical(source), word_text, autojunk=False).get_matching_blocks()
    result, timed, cursor = [], [], 0
    for segment in fallback:
        first_item = len(timed)
        text = segment["text"]
        letters = [i for i, char in enumerate(text) if char.isalnum()]
        anchors, points = [], []
        for a, b, start, end, uncertain in entries:
            if a == b or not math.isfinite(start) or not math.isfinite(end) or end < start:
                continue
            # 문장 시각과 단어 시각은 별도 추정치다. 경계를 조금 넘는 첫
            # 단어를 버리면 긴 선행 무음의 보정 대상에서도 빠져 버린다.
            if end < segment["start_ts"] or start > segment["end_ts"]:
                continue
            for block in blocks:
                if block.b <= a and b <= block.b+block.size:
                    left, right = block.a+a-block.b-cursor, block.a+b-block.b-cursor
                    if 0 <= left < right <= len(letters):
                        if start == end:
                            points.append((left, right, start))
                            break
                        if not anchors or (left >= anchors[-1][1] and start >= anchors[-1][3]):
                            bounded_start = max(offset, start, segment["start_ts"])
                            bounded_end = min(end, segment["end_ts"])
                            if bounded_end > bounded_start:
                                anchors.append((left, right, bounded_start, bounded_end, uncertain))
                    break
        if not anchors:
            timed.append(dict(segment))
        else:
            def point_range(left, right):
                selected = [p for p in points if left <= p[0] and p[1] <= right]
                if (not selected or selected[0][0] != left or selected[-1][1] != right
                        or any(a[1] != b[0] or a[2] > b[2] for a, b in zip(selected, selected[1:]))):
                    return None
                return selected[0][2], selected[-1][2]

            # 시간 정렬이 실패한 부분만 남겨 원문을 누락하거나 임의로 바꾸지 않는다.
            position, previous_end, previous_letter = 0, segment["start_ts"], 0
            for left, right, start, end, uncertain in anchors:
                char_start = letters[left]
                char_end = letters[right] if right < len(letters) else len(text)
                gap = text[position:char_start]
                prefix = gap if position == 0 and not canonical(gap) else ""
                joined_point = False
                if canonical(gap):
                    evidence = point_range(previous_letter, left)
                    gap_start = previous_end
                    supported = evidence and previous_end <= evidence[0] <= evidence[1] <= start
                    if supported:
                        # 길이 0도 '어디에 있었는지'는 남아 있다. 그 근거를 버려
                        # 문장 시작부터 다음 단어까지 무음 전체를 채우지 않는다.
                        gap_start = evidence[0]
                    if supported and gap_start == start:
                        prefix, joined_point = gap, True
                    elif start <= gap_start:
                        anchors = []
                        break
                    else:
                        timed.append({"text": gap, "start_ts": gap_start, "end_ts": start,
                                      "_timing_uncertain": True})
                elif gap and timed and position > 0:
                    timed[-1]["text"] += gap
                timed.append({"text": prefix + text[char_start:char_end], "start_ts": start, "end_ts": end,
                              **({"_timed_word": True} if word_output and not (joined_point or uncertain) else {}),
                              **({"_timing_uncertain": True} if joined_point or uncertain else {})})
                position, previous_end, previous_letter = char_end, end, right
            tail = text[position:]
            if anchors and canonical(tail):
                evidence = point_range(previous_letter, len(letters))
                if evidence and evidence == (previous_end, previous_end):
                    timed[-1]["text"] += tail
                    timed[-1]["_timing_uncertain"] = True
                    timed[-1].pop("_timed_word", None)
                elif previous_end < segment["end_ts"]:
                    timed.append({"text": tail, "start_ts": previous_end, "end_ts": segment["end_ts"],
                                  "_timing_uncertain": True})
                else:
                    anchors = []
            if not anchors:
                del timed[first_item:]
                timed.append(dict(segment))
        cursor += len(letters)
        # 창을 합칠 때까지 단어와 모델 발언 경계를 보존한다.
        if word_output:
            result.extend(dict(word, _segment="qwen" if engine == "qwen" else (offset, cursor)) for word in timed[first_item:])
        else:
            result.extend(group_timed_words(timed[first_item:], total_duration,
                                            gap_threshold=0.65 if engine == "qwen" else 0.3))
    result = normalize_chunks(result, total_duration=total_duration)
    if not word_output:
        result = [{k: v for k, v in cue.items() if not k.startswith("_")} for cue in result]
    return result


def group_timed_words(timed, total_duration=None, *, gap_threshold=0.3):
    result, current, previous = [], None, None
    for word in timed:
        gap = word["start_ts"] - current["end_ts"] if current else 0
        acoustic_gap = 0
        if previous is not None and "_acoustic_end" in previous and "_acoustic_start" in word:
            acoustic_gap = word["_acoustic_start"] - previous["_acoustic_end"]
        # CTC 활성 구간은 발음 전체가 아니다. 기존 음향 대조에서 문장을
        # 나누던 긴 쉼만 보존하며, 표시 여유가 그 쉼을 가리지 않게 한다.
        acoustic_pause = acoustic_gap >= .65 - 1e-6
        # 길이 목표를 넘겨도 일본어의 단어 조각 한가운데를 먼저 자르지 않는다.
        boundary = bool(current and (gap >= 0.12 or acoustic_gap >= .16
                                     or current["text"].endswith((" ", "、", ",", ";", "；", ":", "："))
                                     or word["text"].startswith(" ")))
        length = len(current["text"] + word["text"]) if current else 0
        duration = word["end_ts"] - current["start_ts"] if current else 0
        if current and (word.get("_segment") != current.get("_segment")
                        or word["start_ts"] < current["end_ts"]
                        or gap >= gap_threshold
                        or acoustic_pause
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
            current.pop("_acoustic_end", None)
            if "_acoustic_end" in word:
                current["_acoustic_end"] = word["_acoustic_end"]
        if current["text"].rstrip(' \t\n\"\'」』）)]').endswith(("。", "！", "？", ".", "!", "?")):
            result.append(current)
            current = None
        previous = word
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
        text = str(get("text", "") or "")
        if get("_segment") is None:
            text = text.strip()
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
        cue = {"text": text, "start_ts": start, "end_ts": end}
        if get("_segment") is not None:
            cue["_segment"] = get("_segment")
        if get("_timed_word"):
            cue["_timed_word"] = True
        if get("_timing_uncertain"):
            cue["_timing_uncertain"] = True
        for name in ("_acoustic_start", "_acoustic_end"):
            if get(name) is not None:
                cue[name] = get(name)
        result.append(cue)
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
    def reliable_word(cue):
        return cue.get("_timed_word") and not cue.get("_timing_uncertain")

    def overlaps(cue, others):
        return any(min(cue["end_ts"], c["end_ts"])-max(cue["start_ts"], c["start_ts"])
                   > (0.001 if reliable_word(cue) and reliable_word(c) else 0.05) for c in others)

    # 두 창이 같은 시각의 같은 단어를 인식했다면 그 단어 뒤에서 연결한다.
    # 고정 시각으로 문장/단어를 자르면 앞 문장 전체가 다음 자막에 반복될 수 있다.
    key = lambda c: "".join(char for char in c["text"] if char.isalnum())
    anchors = [(abs((a["end_ts"]+b["end_ts"])/2-seam), i, j)
               for i, a in enumerate(existing) if reliable_word(a) and abs(a["end_ts"]-seam) <= 2.5
               for j, b in enumerate(incoming) if reliable_word(b) and abs(b["end_ts"]-seam) <= 2.5
               and key(a) == key(b) and key(a) and overlaps(a, [b])]
    if anchors:
        _, left, right = min(anchors)
        before, after = existing[:left+1], incoming[right+1:]
        missing_before, missing_after = incoming[:right+1], existing[left+1:]
    else:
        before = [c for c in existing if (c["start_ts"]+c["end_ts"])/2 < seam]
        after = [c for c in incoming if (c["start_ts"]+c["end_ts"])/2 >= seam]
        missing_before = [c for c in incoming if (c["start_ts"]+c["end_ts"])/2 < seam]
        missing_after = [c for c in existing if (c["start_ts"]+c["end_ts"])/2 >= seam]
    represented = _seam_text_coverage(existing, incoming, seam)
    def already_present(cue, selected):
        counterparts = represented.get(id(cue))
        return counterparts is not None and counterparts <= {id(c) for c in selected}

    # 한쪽 인식이 놓친 대사는 소유권 경계만으로 버리지 않는다.
    # 시각이 밀린 같은 문장 조각은 무음에 놓여도 누락 대사가 아니다.
    # 다른 추론 창의 연속 원문과 대응할 때만 복구 대상에서 제외한다.
    selected = before + after
    before = before + [c for c in missing_before if not overlaps(c, selected) and not already_present(c, selected)]
    after = after + [c for c in missing_after if not overlaps(c, before + after) and not already_present(c, before + after)]
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


def _seam_text_coverage(existing, incoming, seam):
    """연결 부근 두 추론의 연속 글자를 대응한다. 같은 추론의 반복은 건드리지 않는다."""
    def indexed(cues):
        text, owners = "", []
        for cue in cues:
            if cue["end_ts"] < seam - 5 or cue["start_ts"] > seam + 5:
                continue
            value = "".join(c for c in cue["text"] if c.isalnum())
            text += value
            owners.extend([cue] * len(value))
        return text, owners

    a, left = indexed(existing)
    b, right = indexed(incoming)
    left_cues, right_cues = list({id(c): c for c in left}.values()), list({id(c): c for c in right}.values())
    key = lambda c: "".join(char for char in c["text"] if char.isalnum())

    def same_word(source, target):
        return (bool(source.get("_timed_word") or source.get("_timing_uncertain"))
                and bool(target.get("_timed_word") or target.get("_timing_uncertain"))
                and key(source) == key(target) and bool(key(source))
                and min(source["end_ts"], target["end_ts"])-max(source["start_ts"], target["start_ts"]) > .001)

    covered, required = {}, {}
    for owners in (left, right):
        for cue in owners:
            required[id(cue)] = required.get(id(cue), 0) + 1
    for block in SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks():
        pairs = list(zip(left[block.a:block.a+block.size], right[block.b:block.b+block.size]))
        if block.size < 4:
            # 짧은 단어도 두 추론에서 온전한 단어/시각이 유일하게 겹치면
            # 이미 선택된 대사다. 부분 글자 일치나 여러 맞장구는 제외한다.
            if not pairs or not all(same_word(x, y)
                    and sum(same_word(x, c) for c in right_cues) == 1
                    and sum(same_word(c, y) for c in left_cues) == 1 for x, y in pairs):
                continue
        if any(abs(x["start_ts"]-y["start_ts"]) > 4 or abs(x["end_ts"]-y["end_ts"]) > 4 for x, y in pairs):
            continue
        for x, y in pairs:
            for source, target in ((x, y), (y, x)):
                count, targets = covered.setdefault(id(source), [0, set()])
                covered[id(source)][0] = count + 1
                targets.add(id(target))
    return {key: targets for key, (count, targets) in covered.items() if count == required[key]}


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
