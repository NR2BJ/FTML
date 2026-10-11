"""원문을 고정한 음향 대조. 인식 모델의 시각과 음향 근거를 구분한다."""

import math
import unicodedata


def letters(text):
    return "".join(c for c in unicodedata.normalize("NFKC", text).lower() if c.isalnum())


def japanese_text(chunks, language):
    if language not in (None, "", "auto", "ja"):
        return False
    text = "".join(c["text"] for c in chunks)
    kana = sum("\u3040" <= c <= "\u30ff" for c in text)
    return kana >= 8 and (language == "ja" or kana >= .2 * len(letters(text)))


def batches(chunks, duration):
    """최대 30초의 원음만 읽는다. 원문/단어를 복제하거나 창끼리 재인식하지 않는다."""
    start = 0
    while start < len(chunks):
        end, length, boundary = start, 0, None
        while end < len(chunks):
            cue = chunks[end]
            if end > start and (cue["end_ts"] - chunks[start]["start_ts"] > 26 or length + len(cue["text"]) > 360):
                break
            length += len(cue["text"])
            end += 1
            if end < len(chunks) and cue["end_ts"] - chunks[start]["start_ts"] >= 5:
                following = chunks[end]
                if (cue["text"].rstrip().endswith(("。", "！", "？", ".", "!", "?"))
                        or following.get("_segment") != cue.get("_segment")
                        or following["start_ts"] - cue["end_ts"] >= .5):
                    boundary = end
        if end < len(chunks) and boundary is not None:
            end = boundary
        current = chunks[start:end]
        yield current, max(0, current[0]["start_ts"] - 2), min(duration, max(c["end_ts"] for c in current) + 2)
        start = end


def token_spans(text, pieces):
    """분절기의 모든 글자가 원문과 정확히 대응할 때만 시각을 사용한다."""
    cursor, result = 0, []
    for piece in pieces:
        if not piece or text[cursor:cursor + len(piece)] != piece:
            raise ValueError("음향 분절과 원문이 다릅니다")
        result.append((cursor, cursor + len(piece)))
        cursor += len(piece)
    if cursor != len(text):
        raise ValueError("음향 분절에서 원문 일부가 누락되었습니다")
    return result


def corroborate_evidence(original, repeated):
    """입력 범위를 바꿔도 모든 분절 시각이 일치할 때만 서로의 음향 근거를 보완한다."""
    if len(original) != len(repeated) or not original:
        return None
    result = []
    for first, second in zip(original, repeated):
        if ((first["first"], first["last"]) != (second["first"], second["last"])
                or not all(math.isfinite(second[k]) for k in ("start", "end", "score"))
                or second["end"] <= second["start"]
                or abs(first["start"]-second["start"]) > .12
                or abs(first["end"]-second["end"]) > .12):
            return None
        # 시각을 평균 내거나 새 글자를 만들지 않는다. 첫 대조의 위치를
        # 유지하고, 일치한 재검사에서 확인된 글자의 근거만 보완한다.
        result.append(dict(first, score=max(first["score"], second["score"]),
                           agrees=first["agrees"] or second["agrees"]))
    return result


def propose(chunks, evidence, duration):
    """독립 음향 근거가 충분한 발언만 교체하고 약한 구간은 원래 단어를 남긴다.

    evidence: 원문의 연속 글자 범위(first/last), 절대 시각, 음향 점수,
    강제 경로와 독립 최댓값 경로의 일치 여부. 점수는 정확도 확률이 아니다.
    """
    text = letters("".join(c["text"] for c in chunks))
    cursor = 0
    for item in evidence:
        if (item["first"] != cursor or item["last"] <= cursor
                or not all(math.isfinite(item[k]) for k in ("start", "end", "score"))
                or item["start"] < -.5 or item["end"] <= item["start"] or item["end"] > duration + .5):
            raise ValueError("음향 시각 근거가 불완전합니다")
        cursor = item["last"]
    if cursor != len(text) or not evidence:
        raise ValueError("원문 전체에 대응하는 음향 근거가 없습니다")
    if any(a["end"] > b["start"] for a, b in zip(evidence, evidence[1:])):
        raise ValueError("음향 시각 순서가 바뀌었습니다")

    # 분절 하나가 여러 원래 단어에 걸치면 함께 취급한다. 그 안의 글자
    # 시각을 균등 배분하지 않고, 실패할 때도 원래 단어를 온전히 돌려준다.
    atoms, word_index, token_index, position = [], 0, 0, 0
    while word_index < len(chunks):
        first_word, first_token = word_index, token_index
        while word_index < len(chunks):
            position += len(letters(chunks[word_index]["text"]))
            word_index += 1
            while token_index < len(evidence) and evidence[token_index]["last"] <= position:
                token_index += 1
            if token_index and evidence[token_index - 1]["last"] == position:
                break
        if token_index == first_token:
            raise ValueError("음향 근거가 없는 원문 조각입니다")
        atoms.append((chunks[first_word:word_index], evidence[first_token:token_index]))

    runs, words, points = [], [], []
    for source, aligned in atoms:
        gap = aligned[0]["start"] - points[-1]["end"] if points else 0
        boundary = words and (words[-1]["text"].rstrip().endswith(("。", "！", "？", ".", "!", "?"))
                              or words[-1].get("_segment") != source[0].get("_segment"))
        clause_pause = (words and gap >= .3 and source[0]["start_ts"]-words[-1]["end_ts"] >= .65
                        and words[-1]["text"].rstrip().endswith(("、", ",", ";", "；", ":", "：")))
        if points and (gap >= .65 or boundary or clause_pause
                       or (gap >= .16 and (aligned[-1]["end"] - points[0]["start"] > 6
                                          or len("".join(w["text"] for w in words + source)) > 56))):
            runs.append((words, points))
            words, points = [], []
        words += source
        points += aligned
    if words:
        runs.append((words, points))

    proposals = []
    for words, points in runs:
        count = sum(p["last"] - p["first"] for p in points)
        score = sum(p["score"] * (p["last"] - p["first"]) for p in points) / count
        agreement = sum((p["last"] - p["first"]) for p in points if p["agrees"]) / count
        first, last = points[0], points[-1]
        # CTC 활성 시각은 발음 전체의 길이가 아니다. 짧은 표시 여유만
        # 허용하고 긴 무음이나 다음 화자의 발언까지 채우지 않는다.
        start = max(0, first["start"] - min(.32, .10 + .055 * (first["last"] - first["first"])))
        end = min(duration, last["end"] + .24)
        native_start, native_end = words[0]["start_ts"], max(w["end_ts"] for w in words)
        preserves_boundary = all(a.get("_segment") == b.get("_segment") for a, b in zip(words, words[1:]))
        accepted = (count >= 2 and score >= -2 and agreement >= .75
                    and preserves_boundary
                    and not any(a["end_ts"] > b["start_ts"] for a, b in zip(words, words[1:]))
                    and min(p["score"] for p in points) >= -8
                    and first["agrees"] and last["agrees"]
                    and first["start"] >= 0 and last["end"] <= duration
                    and end - start >= .35 and end - start <= 12
                    and abs(start - native_start) <= 4 and abs(end - native_end) <= 4)
        kind = "phrase"
        support_end = last["end"]
        # 문장 끝을 확신하지 못해도 긴 선행 무음의 근거까지 버리지 않는다.
        # 앞의 연속 두 글자 이상이 독립 음향 경로와 일치할 때만 시작을
        # 늦추며, 끝 시각은 원래대로 둔다. 시각을 앞당기거나 원문을 바꾸지 않는다.
        prefix = []
        for point in points:
            if not point["agrees"] or point["score"] < -2:
                break
            prefix.append(point)
        first_boundary = next((i for i in range(1, len(words))
                               if words[i].get("_segment") != words[0].get("_segment")), len(words))
        first_utterance_end = max(w["end_ts"] for w in words[:first_boundary])
        if (not accepted and prefix and agreement >= .5
                and sum(p["last"]-p["first"] for p in prefix) >= 2
                and words[0]["end_ts"]-native_start >= 1
                and .6 <= start-native_start <= 4
                and .35 <= native_end-start <= 6
                and first_utterance_end-start >= .35
                and prefix[-1]["end"] <= native_end
                and first["start"] >= 0
                and not any(a["end_ts"] > b["start_ts"] for a, b in zip(words, words[1:]))):
            end, support_end, accepted, kind = native_end, native_end, True, "onset"
        candidate = {"text": "".join(w["text"] for w in words), "start_ts": start, "end_ts": end,
                     "_segment": ("acoustic", first["first"], native_start)}
        candidates = [candidate]
        if kind == "onset":
            # 시작만 확인했으므로 첫 발언의 끝과 뒤 발언들의 시각/경계는
            # 건드리지 않는다. 공유 분절을 잘라 짧은 끝 글자를 만들지도 않는다.
            candidates = [dict(candidate, text="".join(w["text"] for w in words[:first_boundary]),
                               end_ts=first_utterance_end)] + [dict(w) for w in words[first_boundary:]]
        proposals.append({"original": words, "candidate": candidates, "accepted": accepted,
                          "support_start": first["start"], "support_end": support_end, "kind": kind,
                          "support_end_known": kind == "phrase"})
    return proposals


def display_units(proposals, policy="supported"):
    """채택한 시각과 표시 경계를 분리한다. 보정 작업의 번호는 발언 경계가 아니다."""
    if policy not in ("source", "supported", "legacy"):
        raise ValueError("알 수 없는 자막 묶음 정책입니다")
    result = []
    for entry in proposals:
        chosen = entry["candidate"] if entry["accepted"] else entry["original"]
        for index, item in enumerate(chosen):
            cue = dict(item)
            if policy != "legacy" and entry["accepted"]:
                original = entry["original"]
                segment = original[0].get("_segment")
                full_support = ("support_start" in entry and "support_end" in entry
                                and entry.get("support_end_known", entry.get("kind") != "onset"))
                # 하나의 음향 분절이 여러 발언 경계를 걸치면 내부 시각을
                # 만들어 나누지 않는다. 이 덩어리의 양쪽 경계는 보수적으로 유지한다.
                if (segment is not None and all(c.get("_segment") == segment for c in original)
                        and (policy == "source" or full_support)):
                    # 약한 이웃과 합치면 방금 확인한 발화 시작이 다시 당겨진다.
                    # 양쪽 끝을 확인한 덩어리끼리만 작업 경계를 제거한다.
                    cue["_segment"] = segment if policy == "source" else ("acoustic_supported", segment)
                if index == 0 and "support_start" in entry:
                    cue["_acoustic_start"] = entry["support_start"]
                if index == len(chosen)-1 and full_support:
                    cue["_acoustic_end"] = entry["support_end"]
            result.append(cue)
    if "".join(c["text"] for c in result) != "".join(c["text"] for p in proposals for c in p["original"]):
        raise ValueError("음향 대조 중 원문이 바뀌었습니다")
    return result


def resolve(proposals, *, display_policy="legacy"):
    """교체 시각이 유지할 이웃을 침범하면 교체를 취소한다. 글자/시각을 자르지 않는다."""
    changed = True
    while changed:
        changed = False
        for left, right in zip(proposals, proposals[1:]):
            original_overlap = max(c["end_ts"] for c in left["original"]) - right["original"][0]["start_ts"]
            if original_overlap > 1e-6:
                # 단일 순서 CTC로 겹친 화자를 다시 배열하지 않는다.
                for entry in (left, right):
                    if entry["accepted"]:
                        entry["accepted"] = False
                        changed = True
                continue
            # 신뢰 못 한 짧은 조각을 새로운 독립 자막으로 드러내지 않는다.
            # 원래 한 묶음이던 이웃만 보호하고, 조각의 시각은 추정하지 않는다.
            old_left, old_right = left["original"][-1], right["original"][0]
            join_gap = .65 if old_left.get("_segment") == "qwen" else .3
            originally_joined = (old_left.get("_segment") == old_right.get("_segment")
                                 and 0 <= old_right["start_ts"] - old_left["end_ts"] < join_gap
                                 and not old_left["text"].rstrip().endswith(("。", "！", "？", ".", "!", "?")))
            if originally_joined and left["accepted"] != right["accepted"]:
                retained, replacement = (right, left) if left["accepted"] else (left, right)
                original = retained["original"]
                if (len(letters("".join(c["text"] for c in original))) <= 3
                        and max(c["end_ts"] for c in original) - original[0]["start_ts"] < .65):
                    replacement["accepted"] = False
                    changed = True
            a = left["candidate"] if left["accepted"] else left["original"]
            b = right["candidate"] if right["accepted"] else right["original"]
            overlap = max(c["end_ts"] for c in a) - b[0]["start_ts"]
            if overlap > max(0, original_overlap) + 1e-6:
                # 읽기 여유만 겹친 경우에는 그 여유만 줄인다. 음향 근거를
                # 잘라내거나 원래 단어의 시각을 밀어서 충돌을 숨기지 않는다.
                if left["accepted"] and right["accepted"] and left.get("support_end", math.inf) <= right.get("support_start", -math.inf):
                    boundary = (max(b[0]["start_ts"], left["support_end"])
                                + min(a[-1]["end_ts"], right["support_start"])) / 2
                    a[-1]["end_ts"], b[0]["start_ts"] = boundary, boundary
                    continue
                if left["accepted"] and left.get("support_end", math.inf) <= b[0]["start_ts"]:
                    a[-1]["end_ts"] = b[0]["start_ts"]
                    continue
                if right["accepted"] and right.get("support_start", -math.inf) >= a[-1]["end_ts"]:
                    b[0]["start_ts"] = a[-1]["end_ts"]
                    continue
                for entry in (left, right):
                    if entry["accepted"]:
                        entry["accepted"] = False
                        changed = True
    return display_units(proposals, display_policy), sum(p["accepted"] for p in proposals)
