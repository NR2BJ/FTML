"""일본어 음향 대조. 인식 모델을 해제한 뒤 CPU에서 순차 실행한다."""

import logging
import sys

import numpy as np

from acoustic_timing import batches, corroborate_evidence, letters, propose, resolve, token_spans
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
        proposals, checked, skipped, rechecks = [], 0, 0, 0
        # 한 글자 미지원 때문에 수십 초 전체를 포기하지 않는다. 미지원
        # 단어 자체는 삭제/보간하지 않고 원래 시각을 가진 별도 구간으로 둔다.
        groups, known, supported_words = [], [], []
        tokenizer = self.processor.tokenizer
        for cue in chunks:
            if cancel is not None and cancel.is_set():
                raise InterruptedError("Transcription cancelled")
            ids = tokenizer(letters(cue["text"]), add_special_tokens=False).input_ids
            supported = bool(ids) and tokenizer.unk_token_id not in ids and self.model.config.pad_token_id not in ids
            supported_words.append(supported)
            if not supported:
                if known:
                    groups += [(s, a, b, True) for s, a, b in batches(known, duration)]
                    known = []
                groups.append(([cue], cue["start_ts"], cue["end_ts"], False))
            else:
                known.append(cue)
        if known:
            groups += [(s, a, b, True) for s, a, b in batches(known, duration)]
        cursor = 0
        for source, start, end, supported in groups:
            begin, finish = cursor, cursor + len(source)
            cursor = finish
            if cancel is not None and cancel.is_set():
                raise InterruptedError("Transcription cancelled")
            try:
                if not supported:
                    raise ValueError("음향 모델 어휘에 없는 단어입니다")
                start, end = self._window(chunks, supported_words, begin, finish, start, end, duration)
                if end - start > 30:
                    raise ValueError("단어 묶음의 음성 범위가 너무 깁니다")
                first, last = int(start * 16000), min(int(duration * 16000), int(end * 16000))
                # 음성 여유 구간에 앞 대사가 있는데 원문은 뒷 대사부터 주면
                # 같은 음절을 앞 대사에 강제 대응할 수 있다. 같은 30초 안의
                # 이웃 원문도 대조하되 소유한 구간의 시각만 한 번 채택한다.
                context, owned_start, owned_end = self._context(chunks, supported_words, begin, finish, first/16000, last/16000)
                evidence = self.evidence(audio_getter(first, last), context, first / 16000, cancel)
                evidence = [dict(p, first=p["first"]-owned_start, last=p["last"]-owned_start)
                            for p in evidence if owned_start <= p["first"] and p["last"] <= owned_end]
                current = propose(source, evidence, duration)
                current, attempts = self._recheck(current, evidence, audio_getter, duration, cancel, trace)
                proposals += current
                rechecks += attempts
                checked += 1
                emit(trace, "acoustic_evidence", offset=first / 16000, evidence=evidence, source=source)
            except ValueError as exc:
                # 미지원 글자/경계/낮은 대응은 실패한 자막을 만들지 않는다.
                skipped += 1
                proposals.append(dict(original=source, candidate=source, accepted=False))
                log.info("음향 대조 구간 유지: %.2f~%.2f (%s)", start, end, exc)
        emit(trace, "acoustic_proposals", proposals=proposals)
        result, accepted = resolve(proposals)
        emit(trace, "acoustic_review", cues=result)
        return result, {"timing_acoustic_checked": checked, "timing_acoustic_skipped": skipped,
                        "timing_acoustic_accepted": accepted, "timing_acoustic_model": MODEL,
                        "timing_acoustic_rechecks": rechecks,
                        "timing_acoustic_recovered": sum(p["accepted"] and p.get("kind")=="rechecked" for p in proposals)}

    def _recheck(self, proposals, evidence, audio_getter, duration, cancel, trace):
        attempts, cursor = 0, 0
        for index, entry in enumerate(proposals):
            text = letters("".join(c["text"] for c in entry["original"]))
            points = [dict(p, first=p["first"]-cursor, last=p["last"]-cursor)
                      for p in evidence if cursor <= p["first"] and p["last"] <= cursor+len(text)]
            cursor += len(text)
            if entry["accepted"] or attempts >= 2 or len(text) < 2 or not points:
                continue
            agreement = sum(p["last"]-p["first"] for p in points if p["agrees"]) / len(text)
            score = sum(p["score"]*(p["last"]-p["first"]) for p in points) / len(text)
            if (points[0]["agrees"] and points[-1]["agrees"] or agreement < .5
                    or score < -2 or min(p["score"] for p in points) < -8):
                continue
            padding = .8 if points[-1]["end"]-points[0]["start"] < .8 else 1.6
            start, end = max(0, points[0]["start"]-padding), min(duration, points[-1]["end"]+padding)
            if not .4 <= end-start <= 12:
                continue
            if cancel is not None and cancel.is_set():
                raise InterruptedError("Transcription cancelled")
            attempts += 1
            try:
                first, last = int(start*16000), int(end*16000)
                repeated = self.evidence(audio_getter(first,last), text, first/16000, cancel)
                combined = corroborate_evidence(points, repeated)
                revised = propose(entry["original"], combined, duration) if combined else []
                if len(revised)==1 and revised[0]["accepted"]:
                    proposals[index] = dict(revised[0], kind="rechecked")
                emit(trace, "acoustic_recheck", source=entry["original"], original=points, repeated=repeated,
                     accepted=proposals[index]["accepted"])
            except ValueError:
                # 대조 범위가 달라져도 실패한 글자를 삭제하거나 시각을 추정하지 않는다.
                continue
        return proposals, attempts

    @staticmethod
    def _window(chunks, supported, begin, end, start_time, end_time, duration):
        # 단어 시각이 없는 앞 문장 전체도 문맥으로 쓸 수 있게 하되,
        # 최대 30초/가까운 이웃 하나라는 처리 한도는 그대로 지킨다.
        if begin and supported[begin-1] and chunks[begin]["start_ts"]-chunks[begin-1]["start_ts"] <= 5:
            earlier = min(start_time, max(0, chunks[begin-1]["start_ts"]-.3))
            if end_time-earlier <= 30:
                start_time = earlier
        if end < len(chunks) and supported[end] and chunks[end]["end_ts"]-chunks[end-1]["end_ts"] <= 5:
            later = max(end_time, min(duration, chunks[end]["end_ts"]+.3))
            if later-start_time <= 30:
                end_time = later
        return start_time, end_time

    def _context(self, chunks, supported, begin, end, start_time, end_time):
        """기존 음성 범위 안의 이웃만 포함한다. 분절 하나를 소유권 경계에서 자르지 않는다."""
        first, last = begin, end
        size = sum(len(letters(c["text"])) for c in chunks[begin:end])
        while first > 0 and supported[first-1] and chunks[first-1]["start_ts"] >= start_time:
            length = len(letters(chunks[first-1]["text"]))
            if size+length > 420:
                break
            first, size = first-1, size+length
        while last < len(chunks) and supported[last] and chunks[last]["end_ts"] <= end_time:
            length = len(letters(chunks[last]["text"]))
            if size+length > 420:
                break
            last, size = last+1, size+length
        tokenizer = self.processor.tokenizer
        while True:
            text = letters("".join(c["text"] for c in chunks[first:last]))
            left = len(letters("".join(c["text"] for c in chunks[first:begin])))
            right = left + len(letters("".join(c["text"] for c in chunks[begin:end])))
            ids = tokenizer(text, add_special_tokens=False).input_ids
            spans = token_spans(text, tokenizer.convert_ids_to_tokens(ids))
            boundaries = {0, *(b for _, b in spans)}
            if left in boundaries and right in boundaries:
                return text, left, right
            # 이웃과 한 분절로 합쳐진 경계에는 가짜 글자 시각을 나누지 않는다.
            if left not in boundaries:
                first = begin
            if right not in boundaries:
                last = end
