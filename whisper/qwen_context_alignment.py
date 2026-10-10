"""다음 발언에 붙은 짧은 문장 끝을 서로 다른 음성 여유 범위에서 대조한다."""

from qwen_alignment import (
    alignment_issue_count, canonical_text, preserves_stable_words, validated_original_words,
)


def _sentence_end(text):
    return text.rstrip(' \t\n\"\'」』）)]').endswith(("。", "！", "？", ".", "!", "?"))


def _stranded_run(sentence, following):
    if not following or not _sentence_end(sentence[-1]["word"]):
        return None
    body = "".join(w["word"] for w in sentence).rstrip(' \t\n\"\'」』）)]。！？.!?')
    if any(mark in body for mark in "。！？.!?"):
        return None
    # 문장 끝이 다음 발언의 시작에 몰린 경우만 다룬다. 긴 정상 발음이나
    # 문장 중간의 쉼을 불확실한 꼬리로 간주하지 않는다.
    if sentence[-1]["end_ts"] != sentence[-1]["start_ts"]:
        return None
    if not 0 <= following["start_ts"]-sentence[-1]["end_ts"] <= 0.24:
        return None
    for begin in range(1, len(sentence)-2):
        end = begin
        while end < len(sentence) and sentence[end]["start_ts"] == sentence[end]["end_ts"]:
            if end > begin and sentence[end]["start_ts"]-sentence[end-1]["end_ts"] > 0.5:
                break
            end += 1
        if end-begin < 2 or end == len(sentence):
            continue
        run, tail = sentence[begin:end], sentence[end:]
        if (sum(len(canonical_text(w["word"])) for w in run) > 8
                or sum(len(canonical_text(w["word"])) for w in tail) > 8
                or any(w["end_ts"]-w["start_ts"] > 0.24+1e-6 for w in tail)
                or tail[-1]["end_ts"]-tail[0]["start_ts"] > 0.32+1e-6
                or tail[0]["start_ts"]-run[-1]["end_ts"] < 0.8
                or sum(w["end_ts"]-w["start_ts"] for w in sentence[:begin]) < 0.5):
            continue
        return begin, end
    return None


def _tokens(words, begin, end):
    parts = ["".join(c for c in w["word"] if c.isalnum() or c == "'") for w in words]
    return parts[:begin] + ["".join(parts[begin:end])] + parts[end:]


def _coarsen_tail(words, prefix_length):
    position = 0
    for index, word in enumerate(words):
        if position == prefix_length:
            # 단어 내부 경계를 추정하지 않는다. 두 검사에서 확인할 수 있는
            # 불확실 구절 전체의 시작/끝만 남기고 원문은 모두 보존한다.
            tail = word.copy()
            tail["word"] = "".join(w["word"] for w in words[index:])
            tail["end_ts"] = words[-1]["end_ts"]
            if not 0.24 <= tail["end_ts"]-tail["start_ts"] <= 4:
                return []
            return words[:index]+[tail]
        position += len(canonical_text(word["word"]))
    return []


def _agree(left, right):
    return len(left) == len(right) and all(
        canonical_text(a["word"]) == canonical_text(b["word"])
        and abs(a["start_ts"]-b["start_ts"]) <= 0.32+1e-6
        and abs(a["end_ts"]-b["end_ts"]) <= 0.32+1e-6
        for a, b in zip(left, right)
    )


def repair_stranded_tails(words, text, duration, align_grouped, cancel=None, max_attempts=2):
    """기존 재정렬 후 남은 실패만 보완한다. 두 결과의 일치는 정확도 보장이 아니다."""
    words = validated_original_words(words, text, duration)
    if max_attempts < 2:
        return words, 0, 0
    ranges, begin = [], 0
    for index, word in enumerate(words):
        if _sentence_end(word["word"]) or index == len(words)-1:
            ranges.append((begin, index+1))
            begin = index+1
    attempts = 0

    def check_cancelled():
        if cancel is not None and cancel.is_set():
            raise InterruptedError("Transcription cancelled")

    def run(source, start, finish, tokens):
        nonlocal attempts
        check_cancelled()
        attempts += 1
        revised = align_grouped(source, start, finish, tokens)
        check_cancelled()
        revised = validated_original_words(revised, source, finish-start)
        return [dict(w, start_ts=w["start_ts"]+start, end_ts=w["end_ts"]+start) for w in revised]

    for begin, end in ranges:
        check_cancelled()
        if attempts+2 > max_attempts:
            break
        original = words[begin:end]
        run_span = _stranded_run(original, words[end] if end < len(words) else None)
        if run_span is None:
            continue
        run_begin, run_end = run_span
        left = (words[begin-1]["end_ts"]+original[0]["start_ts"])/2 if begin else 0
        start = max(left, original[0]["start_ts"]-0.4)
        finish = min((original[-1]["end_ts"]+words[end]["start_ts"])/2, original[-1]["end_ts"]+0.4)
        context_start = max(words[begin-1]["end_ts"] if begin else 0, original[0]["start_ts"]-0.8)
        if not 0.4 <= finish-start <= 12 or start-context_start < 0.24 or not duration <= 30.1:
            continue
        source = "".join(w["word"] for w in original)
        ignored_tail = set(range(run_end, len(original)))
        prefix_length = sum(len(canonical_text(w["word"])) for w in original[:run_begin])
        try:
            revised = _coarsen_tail(run(source, start, finish, _tokens(original, run_begin, run_end)), prefix_length)
            if (not revised or alignment_issue_count(revised) or not preserves_stable_words(original, revised, ignored_tail)
                    or revised[-1]["end_ts"] > original[run_end]["start_ts"]-0.4):
                continue
            # 앞 발언을 침범하지 않는 추가 음성 여유를 준다. 보정 결과에서
            # 유리한 구간을 역산하지 않고 원래 단어 시각으로 두 입력을 정한다.
            confirmed = _coarsen_tail(run(source, context_start, finish, _tokens(original, run_begin, run_end)), prefix_length)
            if (not confirmed or alignment_issue_count(confirmed) or not _agree(revised, confirmed)
                    or not preserves_stable_words(original, confirmed, ignored_tail)):
                continue
            result = words[:begin]+revised+words[end:]
            # 이웃 문장과의 겹침, 원문 변질은 최종 조합에서도 거절한다.
            return validated_original_words(result, text, duration), attempts, 1
        except InterruptedError:
            raise
        except Exception:
            check_cancelled()
    return words, attempts, 0
