"""원음을 자르지 않고 말소리 경계와 추출 시각을 대조한다."""

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
    for word in words:
        word = dict(word)
        start, end = word["start_ts"], word["end_ts"]
        # 단어 시각이 없는 문장 전체에는 이 규칙을 적용하지 않는다.
        if word.get("_timed_word") and end - start >= 1.2:
            previous_end = 0
            for onset, finish in spans:
                if finish <= start:
                    previous_end = finish
                    continue
                # 이전 발화가 일부 포함된 단어를 통째로 뒤로 보내지 않는다.
                if onset <= start + 0.35:
                    break
                if onset > end + 0.4:
                    break
                if onset - max(start, previous_end) >= 0.8:
                    # VAD의 여유 구간 외에도 350ms, 단어 끝 전 200ms를 남긴다.
                    revised = min(onset - 0.35, end - 0.2)
                    if revised - start >= 0.6:
                        word["start_ts"] = revised
                        adjusted += 1
                break
        result.append(word)
    return result, adjusted
