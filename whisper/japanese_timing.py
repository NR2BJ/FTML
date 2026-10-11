"""일본어 음향 대조. 인식 모델을 해제한 뒤 CPU에서 순차 실행한다."""

import logging
import sys

import numpy as np

from acoustic_timing import batches, letters, propose, resolve, token_spans
from ctc_alignment import align_ctc
from extraction_trace import emit


MODEL = "reazon-research/japanese-wav2vec2-large-rs35kh"
REVISION = "2162c9edb97f362f7623d6b3a2e417458e879bca"
log = logging.getLogger("whisper")


class JapaneseTiming:
    def __init__(self, path=None):
        if sys.platform != "linux":
            raise RuntimeError("음향 모델은 Linux 추출 서버에서만 실행합니다")
        import torch
        from transformers import AutoModelForCTC, AutoProcessor
        torch.set_num_threads(2)
        options = {"local_files_only": True} if path else {"revision": REVISION}
        self.processor = AutoProcessor.from_pretrained(path or MODEL, trust_remote_code=False, **options)
        self.model = AutoModelForCTC.from_pretrained(path or MODEL, trust_remote_code=False,
                                                    use_safetensors=True, **options).eval()

    def evidence(self, audio, text, offset, cancel=None):
        import torch
        if cancel is not None and cancel.is_set():
            raise InterruptedError("Transcription cancelled")
        if not 0 < len(audio) <= 30 * 16000 or not np.isfinite(audio).all():
            raise ValueError("음향 대조 입력은 최대 30초입니다")
        tokenizer = self.processor.tokenizer
        encoded = tokenizer(text, add_special_tokens=False).input_ids
        if not encoded or len(encoded) > 450 or self.model.config.pad_token_id in encoded or tokenizer.unk_token_id in encoded:
            raise ValueError("음향 모델 어휘에 없는 글자는 기존 시각을 유지합니다")
        spans = token_spans(text, tokenizer.convert_ids_to_tokens(encoded))
        padded = np.pad(audio, 8000)
        with torch.inference_mode():
            inputs = self.processor(padded, sampling_rate=16000, return_tensors="pt")
            scores = self.model(**inputs).logits[0].float().log_softmax(-1).numpy()
        if cancel is not None and cancel.is_set():
            raise InterruptedError("Transcription cancelled")
        aligned = align_ctc(scores, encoded, self.model.config.pad_token_id)
        scale, greedy = len(padded) / 16000 / len(scores), scores.argmax(-1)
        result = []
        for token, span, point in zip(encoded, spans, aligned):
            first, last = point["start_frame"], point["end_frame"]
            start, end = first * scale - .5, last * scale - .5
            result.append(dict(first=span[0], last=span[1], start=start + offset, end=end + offset,
                               score=point["mean_log_score"], agrees=bool(0 <= start < end <= len(audio)/16000
                                                                        and np.any(greedy[first:last] == token))))
        return result

    def review(self, chunks, audio_getter, duration, cancel=None, trace=None):
        proposals, checked, skipped = [], 0, 0
        # 한 글자 미지원 때문에 수십 초 전체를 포기하지 않는다. 미지원
        # 단어 자체는 삭제/보간하지 않고 원래 시각을 가진 별도 구간으로 둔다.
        groups, known = [], []
        tokenizer = self.processor.tokenizer
        for cue in chunks:
            if cancel is not None and cancel.is_set():
                raise InterruptedError("Transcription cancelled")
            ids = tokenizer(letters(cue["text"]), add_special_tokens=False).input_ids
            if not ids or tokenizer.unk_token_id in ids or self.model.config.pad_token_id in ids:
                if known:
                    groups += [(s, a, b, True) for s, a, b in batches(known, duration)]
                    known = []
                groups.append(([cue], cue["start_ts"], cue["end_ts"], False))
            else:
                known.append(cue)
        if known:
            groups += [(s, a, b, True) for s, a, b in batches(known, duration)]
        for source, start, end, supported in groups:
            if cancel is not None and cancel.is_set():
                raise InterruptedError("Transcription cancelled")
            try:
                if not supported:
                    raise ValueError("음향 모델 어휘에 없는 단어입니다")
                if end - start > 30:
                    raise ValueError("단어 묶음의 음성 범위가 너무 깁니다")
                first, last = int(start * 16000), min(int(duration * 16000), int(end * 16000))
                evidence = self.evidence(audio_getter(first, last), letters("".join(c["text"] for c in source)), first / 16000, cancel)
                proposals += propose(source, evidence, duration)
                checked += 1
                emit(trace, "acoustic_evidence", offset=first / 16000, evidence=evidence)
            except ValueError as exc:
                # 미지원 글자/경계/낮은 대응은 실패한 자막을 만들지 않는다.
                skipped += 1
                proposals.append(dict(original=source, candidate=source, accepted=False))
                log.info("음향 대조 구간 유지: %.2f~%.2f (%s)", start, end, exc)
        emit(trace, "acoustic_proposals", proposals=proposals)
        result, accepted = resolve(proposals)
        emit(trace, "acoustic_review", cues=result)
        return result, {"timing_acoustic_checked": checked, "timing_acoustic_skipped": skipped,
                        "timing_acoustic_accepted": accepted, "timing_acoustic_model": MODEL}
