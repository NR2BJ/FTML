"""VAD는 관찰에만 사용한다. 원음이나 자막 시각을 자동으로 잘라내지 않는다."""

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

    def finish(self, chunks):
        merged = []
        for start, end in sorted(self.spans):
            if merged and start <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
            else:
                merged.append((start, end))
        return {"speech_seconds": sum(end-start for start,end in merged),
                "cues_checked": len(chunks),
                "cues_outside_speech": sum(not any(start < c["end_ts"] and end > c["start_ts"] for start,end in merged) for c in chunks)}
