import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from qwen_pipeline import QwenPipeline, normalize_aligned_words


class QwenPipelineTests(unittest.TestCase):
    def make_pipeline(self):
        import numpy as np
        pipe = QwenPipeline.__new__(QwenPipeline)
        pipe.asr = Mock()
        pipe.asr.generate.return_value = SimpleNamespace(texts=["こんにちは。"], languages=["Japanese"])
        pipe.aligner = Mock()
        pipe.aligner.align.return_value = [[SimpleNamespace(text="こんにちは",start_time=2,end_time=3)]]
        return pipe, np.ones(5*16000,dtype=np.float32)

    def test_japanese_uses_official_cpu_aligner_and_language_name(self):
        pipe,audio = self.make_pipeline()
        result = pipe.generate(audio,SimpleNamespace(language="<|ja|>",context="名前"))
        self.assertEqual(pipe.asr.generate.call_args.kwargs["language"],"Japanese")
        self.assertEqual(pipe.asr.generate.call_args.kwargs["context"],"名前")
        self.assertEqual(pipe.aligner.align.call_args.kwargs["language"],"Japanese")
        self.assertEqual(result.words[0]["start_ts"],2)

    def test_untimed_result_does_not_become_full_window_caption(self):
        pipe,audio = self.make_pipeline()
        pipe.aligner.align.return_value = [[]]
        with self.assertRaises(ValueError): pipe.generate(audio,SimpleNamespace(language="ja"))

    def test_unrelated_lyrics_are_rejected(self):
        pipe,audio = self.make_pipeline()
        with self.assertRaises(ValueError): pipe.align_reference(audio,"全然違う歌詞です","ja")

    def test_reference_is_aligned_only_after_transcription_match(self):
        pipe,audio = self.make_pipeline()
        pipe.align_reference(audio,"こんにちは！","ja")
        self.assertEqual(pipe.aligner.align.call_count,2)

    def test_reference_reuses_extracted_words_without_long_gpu_inference(self):
        pipe,audio = self.make_pipeline()
        pipe.align_reference(audio,"こんにちは！","ja","こんにちは。")
        pipe.asr.generate.assert_not_called()
        self.assertEqual(pipe.aligner.align.call_count,1)

    def test_symbols_only_do_not_reach_aligner(self):
        pipe,audio = self.make_pipeline()
        pipe.asr.generate.return_value.texts = [",,,,!!!!!"]
        self.assertEqual(pipe.generate(audio,SimpleNamespace(language="ja")).chunks,[])
        pipe.aligner.align.assert_not_called()

    def test_collapsed_timestamps_join_only_adjacent_words(self):
        words = [{"word":text,"start_ts":start,"end_ts":end} for text,start,end in
                 [("私",7.44,8.08),("もっと",8.48,8.48),("頑張り",8.96,8.96),("ます",11.76,11.92)]]
        result, count = normalize_aligned_words(words, "私もっと頑張ります。", 12)
        self.assertEqual(count, 2)
        self.assertEqual(result[1], {"word":"もっと頑張り","start_ts":8.48,"end_ts":8.96})
        self.assertLess(result[1]["end_ts"], result[2]["start_ts"])

    def test_isolated_collapsed_word_never_fills_long_silence(self):
        words = [{"word":"a","start_ts":1,"end_ts":2},{"word":"b","start_ts":5,"end_ts":5}]
        result,count = normalize_aligned_words(words,"ab",6)
        self.assertEqual(count,1)
        self.assertEqual(result[1],{"word":"b","start_ts":5,"end_ts":5.08})

    def test_missing_text_and_invalid_timestamps_fail_explicitly(self):
        for words,text in [([{"word":"a","start_ts":1,"end_ts":2}], "ab"),
                           ([{"word":"a","start_ts":1,"end_ts":1}], "a"),
                           ([{"word":"a","start_ts":float('nan'),"end_ts":2}], "a")]:
            with self.assertRaises(ValueError): normalize_aligned_words(words,text,6)
