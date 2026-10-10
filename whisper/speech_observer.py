"""원음을 자르지 않고 말소리 경계와 추출 시각을 대조한다."""

import unicodedata

class SpeechObserver:
    def __init__(self):
        from silero_vad import load_silero_vad
        self.model = load_silero_vad(onnx=True)
        self.spans = []

    def observe(self, audio, chunks, offset):
        import torch
        from silero_vad import get_speech_timestamps
        spans = get_speech_timestamps(torch.from_numpy(audio), self.model, sampling_rate=16000,
                                      threshold=0.25, speech_pad_ms=250,
                                      min_silence_duration_ms=400, return_seconds=True)
        self.spans.extend((s["start"]+offset, s["end"]+offset) for s in spans)

    def merged_spans(self):
        merged = []
        for start, end in sorted(self.spans):
            if merged and start <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
            else:
                merged.append((start, end))
        return merged

    def finish(self, chunks):
        merged = self.merged_spans()
        return {"speech_seconds": sum(end-start for start,end in merged),
                "cues_checked": len(chunks),
                "cues_outside_speech": sum(not any(start < c["end_ts"] and end > c["start_ts"] for start,end in merged) for c in chunks)}


def refine_whisper_onsets(words, spans):
    """긴 단어 안의 선행 무음만 줄인다. 검출되지 않은 대사/노래는 지우지 않는다."""
    result, adjusted = [], 0
    for index, word in enumerate(words):
        word = dict(word)
        start, end = word["start_ts"], word["end_ts"]
        initial_fragment = (word.get("_segment") is not None
                            and (index == 0 or words[index-1].get("_segment") != word.get("_segment"))
                            and sum(c.isalnum() for c in word["text"]) <= 4)
        # 단어 시각이 없는 문장 전체에는 이 규칙을 적용하지 않는다.
        if word.get("_timed_word") and end - start >= 1.2:
            previous_end = 0
            for onset, finish in spans:
                if finish <= start:
                    previous_end = finish
                    continue
                if onset <= start + 0.35:
                    # 문장 첫 짧은 조각에 이전 발화의 검출 여유까지 붙은 경우다.
                    # 긴 실제 발음/문장 중간 단어는 건드리지 않는다.
                    if initial_fragment and 0 <= finish-start <= 0.8:
                        previous_end = finish
                        continue
                    break
                if onset > end + 0.4:
                    break
                if onset - max(start, previous_end) >= 0.8:
                    # VAD 자체의 250ms 여유 외에 80ms, 단어 끝 전 200ms를 남긴다.
                    revised = min(onset - 0.08, end - 0.2)
                    if revised - start >= 0.6:
                        word["start_ts"] = revised
                        adjusted += 1
                break
        result.append(word)
    return result, adjusted


def refine_whisper_prefixes(words, spans):
    """문장 첫 두 조각에 무음이 분산된 경우만 하나의 시작 묶음으로 제한한다."""
    result, adjusted, index = [], 0, 0
    while index < len(words):
        first = words[index]
        prefix = words[index:index+2]
        is_start = index == 0 or words[index-1].get("_segment") != first.get("_segment")
        letters = ["".join(c for c in w["text"] if c.isalnum()) for w in prefix]
        if (is_start and len(prefix) == 2 and first.get("_segment") is not None
                and all(w.get("_timed_word") for w in prefix)
                and prefix[1].get("_segment") == first.get("_segment")
                and not any(char in first["text"] for char in "。！？.!?\n")
                and 0 <= prefix[1]["start_ts"]-first["end_ts"] <= 0.1
                and first["end_ts"]-first["start_ts"] >= 0.6
                and prefix[1]["end_ts"]-prefix[1]["start_ts"] >= 1.2
                # 길게 부른 영단어/완성된 어절이 아닌 한중일 문자 조각만 묶는다.
                and all(len(part) == 1 and unicodedata.east_asian_width(part) in ("W", "F") for part in letters)
                and not any(char in first["text"] for char in "、,，:：;；")):
            end = prefix[1]["end_ts"]
            previous_end, onset = None, None
            for start, finish in spans:
                # 통계적 단어 길이만으로 노래나 느린 발음을 줄이지 않는다.
                # 실제 검출된 쉼 뒤에 첫 두 조각의 끝이 모이는 경우만 다룬다.
                if (previous_end is not None and start-previous_end >= 0.25-1e-6
                        and start >= first["end_ts"] and first["start_ts"] < previous_end
                        and 0.12 <= end-start <= 0.8 and end <= finish):
                    onset = start
                previous_end = finish
            if onset is not None and onset-first["start_ts"] >= 1.2:
                # 새 내부 단어 시각을 만들어 내지 않고 두 조각을 함께 표시한다.
                merged = dict(first, text="".join(w["text"] for w in prefix), start_ts=onset-0.08, end_ts=end)
                merged.pop("_timed_word", None)
                result.append(merged)
                adjusted += 1
                index += 2
                continue
        result.append(dict(first))
        index += 1
    return result, adjusted
