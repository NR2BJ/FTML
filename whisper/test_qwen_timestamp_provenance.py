import unittest
from types import SimpleNamespace

from qwen_timestamp_provenance import capture_timestamps, mark_interpolated


class Values(list):
    def tolist(self):
        return list(self)


class TimestampProvenanceTests(unittest.TestCase):
    def test_positive_duration_can_still_be_interpolated(self):
        words = [{"word": "one", "start_ts": 1, "end_ts": 1.2},
                 {"word": "two", "start_ts": 1.4, "end_ts": 1.6}]
        result = mark_interpolated(words, [([1000, 1200, 900, 1600], [1000, 1200, 1400, 1600])])
        self.assertEqual(result[0], words[0])
        self.assertTrue(result[1]["_timing_uncertain"])
        self.assertNotIn("_timing_uncertain", words[1])
        self.assertEqual(result[1]["start_ts"], 1.4)

    def test_millisecond_flooring_is_not_an_interpolation(self):
        words = [{"word": "one", "start_ts": 1, "end_ts": 1.2}]
        self.assertEqual(mark_interpolated(words, [([1000.8, 1200.9], [1000, 1200])]), words)

    def test_count_mismatch_does_not_assign_provenance_to_wrong_words(self):
        for observed in ([], [([], [])], [([0], [0])], [([0, 1], [0, 1])]*2):
            with self.subTest(observed=observed), self.assertRaises(ValueError):
                mark_interpolated([{"word": "one"}], observed)

    def test_wrapper_does_not_change_shared_processor_or_result(self):
        class Processor:
            def fix_timestamp(self, values):
                return [1000, 1200]
            def parse_timestamp(self, values):
                return self.fix_timestamp(values)
        original = SimpleNamespace(aligner_processor=Processor())
        local, observed = capture_timestamps(original)
        self.assertIsNot(local.aligner_processor, original.aligner_processor)
        self.assertEqual(local.aligner_processor.parse_timestamp(Values([1200, 1000])), [1000, 1200])
        self.assertEqual(observed, [([1200, 1000], [1000, 1200])])
        original.aligner_processor.parse_timestamp(Values([1200, 1000]))
        self.assertEqual(len(observed), 1)

    def test_pipeline_keeps_interpolation_provenance_after_projection(self):
        import numpy as np
        from qwen_pipeline import QwenPipeline
        from subtitle_processing import timed_words_to_chunks
        class Processor:
            def fix_timestamp(self, values):
                return [1000, 2000, 2500, 3000]
            def parse_timestamp(self):
                return self.fix_timestamp(Values([1000, 2000, 500, 3000]))
        class Aligner:
            aligner_processor = Processor()
            def align(self, **kwargs):
                times = self.aligner_processor.parse_timestamp()
                return [[SimpleNamespace(text=text, start_time=times[i*2]/1000,
                                         end_time=times[i*2+1]/1000)
                         for i, text in enumerate(("Alpha", "beta"))]]
        pipe = QwenPipeline.__new__(QwenPipeline)
        pipe.aligner = Aligner()
        pipe.realignment_budget = pipe.context_alignment_budget = 0
        result = pipe._align(np.ones(4*16000), "Alpha beta.", "English")
        self.assertEqual(pipe.interpolated_words, 1)
        self.assertEqual(result.words[1]["word"], "beta.")
        self.assertTrue(result.words[1]["_timing_uncertain"])
        projected = timed_words_to_chunks(result.words, result.chunks, engine="qwen", word_output=True)
        self.assertTrue(projected[1]["_timing_uncertain"])
        self.assertNotIn("_timed_word", projected[1])
        self.assertEqual(projected[1]["start_ts"], 2.5)


if __name__ == "__main__":
    unittest.main()
