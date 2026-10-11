import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from japanese_timing import JapaneseTiming


class FakeTokenizer:
    unk_token_id = 0

    def __call__(self, text, **kwargs):
        return SimpleNamespace(input_ids=[0 if c == "x" else ord(c) for c in text])


class JapaneseTimingTests(unittest.TestCase):
    def reviewer(self):
        instance = object.__new__(JapaneseTiming)
        instance.processor = SimpleNamespace(tokenizer=FakeTokenizer())
        instance.model = SimpleNamespace(config=SimpleNamespace(pad_token_id=0))
        return instance

    def test_mac_refuses_before_importing_any_model(self):
        with patch("japanese_timing.sys.platform", "darwin"):
            with self.assertRaisesRegex(RuntimeError, "Linux"):
                JapaneseTiming()

    def test_unsupported_word_is_retained_and_does_not_block_other_batches(self):
        reviewer = self.reviewer()
        read, aligned = [], []
        def evidence(audio, text, offset, cancel):
            aligned.append(text)
            return [dict(first=0, last=len(text), start=offset+2.2, end=offset+2.8, score=-.1, agrees=True)]
        reviewer.evidence = evidence
        source = [dict(text="あいう。", start_ts=2, end_ts=3, _segment=1),
                  dict(text="X", start_ts=5, end_ts=6, _segment=2),
                  dict(text="えおか。", start_ts=8, end_ts=9, _segment=3)]
        def getter(start, end):
            read.append((start, end))
            return None
        result, diagnostics = reviewer.review(source, getter, 12)
        self.assertEqual(aligned, ["あいう", "えおか"])
        self.assertEqual("".join(c["text"] for c in result), "あいう。Xえおか。")
        self.assertEqual(next(c for c in result if c["text"] == "X"), source[1])
        self.assertEqual(diagnostics["timing_acoustic_skipped"], 1)
        self.assertTrue(all(end-start <= 30*16000 for start, end in read))

    def test_cancel_does_not_load_audio(self):
        event = threading.Event()
        event.set()
        reviewer = self.reviewer()
        def forbidden(*args):
            self.fail("취소 후 음성을 읽으면 안 됩니다")
        with self.assertRaises(InterruptedError):
            reviewer.review([dict(text="あいう", start_ts=1, end_ts=2)], forbidden, 3, event)

    def test_invalid_alignment_preserves_original_timestamps(self):
        reviewer = self.reviewer()
        reviewer.evidence = lambda *args: []
        source = [dict(text="あいう。", start_ts=1, end_ts=2)]
        result, diagnostics = reviewer.review(source, lambda *args: None, 3)
        self.assertEqual(result, source)
        self.assertEqual(diagnostics["timing_acoustic_accepted"], 0)
        self.assertEqual(diagnostics["timing_acoustic_skipped"], 1)


if __name__ == "__main__":
    unittest.main()
