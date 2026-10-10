"""Qwen 정렬 결과를 검증하고 정규화된 단어를 원문 표기로 되돌린다."""

import math
import unicodedata


class QwenAlignmentError(ValueError):
    REASONS = {
        "empty": "단어 시각 없음",
        "text_mismatch": "인식 원문과 정렬된 글자 불일치",
        "invalid_time": "잘못된 단어 시각",
        "out_of_range": "음성 구간을 벗어난 단어 시각",
        "all_collapsed": "모든 단어의 시작·끝 시각이 같음",
        "overlap": "단어 시각 역전 또는 겹침",
        "boundary": "구간 끝 단어의 시각을 복구하지 못함",
        "empty_retry": "짧게 재처리한 구간에서 시각을 확인하지 못함",
    }

    def __init__(self, reason, window=None):
        self.reason = reason
        self.window = window
        location = ""
        if window is not None:
            def clock(seconds):
                minutes, seconds = divmod(seconds, 60)
                return f"{int(minutes):02d}:{seconds:06.3f}"
            location = f" ({clock(window[0])}~{clock(window[1])})"
        super().__init__(f"Qwen 단어 시각 정렬 실패{location}: {self.REASONS[reason]}. 기존 자막은 유지됩니다")


def canonical_text(text):
    return "".join(char for char in unicodedata.normalize("NFKC", text).lower() if char.isalnum())


def restore_original_words(words, text):
    expected = canonical_text(text)
    words = [dict(word) for word in words if canonical_text(word["word"])]
    if not words:
        raise QwenAlignmentError("empty")
    if "".join(canonical_text(word["word"]) for word in words) != expected:
        raise QwenAlignmentError("text_mismatch")
    # NFKC는 합자/반각 탁점/한글 자모의 글자 수까지 바꾼다. 원문 경계를
    # 대응시켜 따옴표·공백·전각 표기를 보존하고 한 글자 중간에서 자르지 않는다.
    boundaries = {}
    for end in range(1, len(text) + 1):
        prefix = canonical_text(text[:end])
        if expected.startswith(prefix):
            boundaries[len(prefix)] = end
    result, position, key_end, pending = [], 0, 0, None
    for word in words:
        key_end += len(canonical_text(word["word"]))
        if pending is None:
            pending = dict(word)
        else:
            pending["end_ts"] = word["end_ts"]
        end = boundaries.get(key_end)
        if end is not None:
            pending["word"] = text[position:end]
            result.append(pending)
            position, pending = end, None
    if pending is not None or position != len(text):
        raise QwenAlignmentError("text_mismatch")
    return result


def normalize_aligned_words(words, text, duration):
    if not words:
        raise QwenAlignmentError("empty")
    words = [dict(word) for word in words]
    for word in words:
        try:
            start, end = float(word["start_ts"]), float(word["end_ts"])
        except (TypeError, ValueError, KeyError) as exc:
            raise QwenAlignmentError("invalid_time") from exc
        if not math.isfinite(start) or not math.isfinite(end) or not 0 <= start <= end:
            raise QwenAlignmentError("invalid_time")
        if end > duration + 0.1:
            raise QwenAlignmentError("out_of_range")
        # 공식 모델의 80ms 시각 격자로 끝점이 한 칸 넘는 경우만 제한한다.
        word["start_ts"], word["end_ts"] = min(start, duration), min(end, duration)
    # 정규화로 한 글자가 여러 단어가 되어도, 병합 전에 각 시각을 검증한다.
    if any(right["start_ts"] < left["end_ts"] for left, right in zip(words, words[1:])):
        raise QwenAlignmentError("overlap")
    if not any(word["end_ts"] > word["start_ts"] for word in words):
        raise QwenAlignmentError("all_collapsed")
    words = restore_original_words(words, text)
    sentence_end = lambda value: value.rstrip(' \t\n\"\'」』）)]').endswith(("。", "！", "？", ".", "!", "?"))
    result, collapsed, index = [], sum(word["start_ts"] == word["end_ts"] for word in words), 0
    while index < len(words):
        word = dict(words[index])
        if word["start_ts"] == word["end_ts"]:
            following = words[index+1] if index+1 < len(words) else None
            room_before = word["start_ts"] - (result[-1]["end_ts"] if result else 0)
            room_after = (following["start_ts"] if following else duration) - word["start_ts"]
            # 시각이 완전히 겹쳐 분리할 여유가 없으면 기존 병합을 유지한다.
            # 문장 부호만으로 새 정렬 실패나 인접 발언 시각의 이동을 만들지 않는다.
            separable = room_before >= 0.02 or room_after >= 0.02
            if following and (not sentence_end(word["word"]) or not separable) and word["start_ts"] <= following["start_ts"] <= word["end_ts"] + 0.5:
                words[index+1] = {**following, "word": word["word"] + following["word"], "start_ts": word["start_ts"]}
            elif result and (not sentence_end(result[-1]["word"]) or not separable) and result[-1]["end_ts"] <= word["start_ts"] <= result[-1]["end_ts"] + 0.5:
                result[-1]["word"] += word["word"]
                result[-1]["end_ts"] = word["start_ts"]
            else:
                word["end_ts"] = min(word["start_ts"] + 0.08, duration)
                if following:
                    word["end_ts"] = min(word["end_ts"], following["start_ts"])
                if following and word["end_ts"] <= word["start_ts"] and room_before >= 0.02:
                    word["start_ts"] -= min(0.08, room_before)
                if word["end_ts"] <= word["start_ts"]:
                    raise QwenAlignmentError("boundary")
                result.append(word)
        else:
            result.append(word)
        index += 1
    return result, collapsed
