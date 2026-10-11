import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from japanese_timing import JapaneseTiming
from acoustic_timing import propose


class FakeTokenizer:
    unk_token_id = 0

    def __call__(self, text, **kwargs):
        return SimpleNamespace(input_ids=[0 if c == "x" else ord(c) for c in text])

    def convert_ids_to_tokens(self, ids):
        return [chr(i) for i in ids]


class JapaneseTimingTests(unittest.TestCase):
    def test_recheck_budget_and_fixed_text(self):
        reviewer=self.reviewer()
        source=[dict(text="あい。",start_ts=1+i*3,end_ts=1.8+i*3,_segment=i) for i in range(4)]
        points=[]
        for i in range(4):
            points.extend([dict(first=i*2,last=i*2+1,start=1.3+i*3,end=1.4+i*3,score=-.1,agrees=True),
                           dict(first=i*2+1,last=i*2+2,start=1.6+i*3,end=1.7+i*3,score=-2,agrees=False)])
        calls=[]
        def evidence(audio,text,offset,cancel):
            index=len(calls)
            calls.append(text)
            return [dict(p,first=p["first"]-index*2,last=p["last"]-index*2,agrees=True,score=-.1)
                    for p in points[index*2:index*2+2]]
        reviewer.evidence=evidence
        result,attempts=reviewer._recheck(propose(source,points,15),points,lambda a,b:None,15,None,None)
        self.assertEqual(attempts,2)
        self.assertEqual(calls,["あい","あい"])
        self.assertEqual([p["accepted"] for p in result],[True,True,False,False])
        self.assertEqual("".join(c["text"] for p in result for c in p["original"]),"あい。"*4)

    def test_whole_untimed_neighbor_can_supply_context_within_thirty_seconds(self):
        source=[dict(text="前の言葉です",start_ts=10,end_ts=13),
                dict(text="次の言葉",start_ts=13.4,end_ts=15)]
        start,end=JapaneseTiming._window(source,[True,True],1,2,11.4,17,30)
        self.assertAlmostEqual(start,9.7)
        self.assertLessEqual(end-start,30)
        self.assertEqual(JapaneseTiming._window(source,[False,True],1,2,11.4,17,30),(11.4,17))
        self.assertEqual(JapaneseTiming._window(source,[True,True],1,2,11.4,41.4,50),(11.4,41.4))

    def test_neighbor_text_is_context_only_and_owned_cues_are_emitted_once(self):
        reviewer = self.reviewer()
        source = [dict(text="あい。", start_ts=i, end_ts=i+.5, _segment=i) for i in range(45)]
        seen = []
        def evidence(audio, text, offset, cancel):
            seen.append((text,offset))
            return [dict(first=i,last=i+1,start=offset+.2+i*.25,end=offset+.22+i*.25,score=-9,agrees=False)
                    for i in range(len(text))]
        reviewer.evidence = evidence
        result,_ = reviewer.review(source,lambda a,b:None,50)
        self.assertEqual(result,source)
        self.assertGreater(sum(len(s) for s,_ in seen),sum(len(c["text"])-1 for c in source))

    def test_context_cannot_split_a_shared_token_into_fake_character_times(self):
        reviewer=self.reviewer()
        class Joined(FakeTokenizer):
            def __call__(self,text,**kwargs):
                return SimpleNamespace(input_ids=[1] if text=="あいう" else [ord(c) for c in text])
            def convert_ids_to_tokens(self,ids):
                return ["あいう"] if ids==[1] else super().convert_ids_to_tokens(ids)
        reviewer.processor.tokenizer=Joined()
        source=[dict(text="あ",start_ts=1,end_ts=2),dict(text="い",start_ts=2,end_ts=3),dict(text="う",start_ts=3,end_ts=4)]
        self.assertEqual(reviewer._context(source,[True]*3,1,2,0,5),("い",0,1))

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
