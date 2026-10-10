import copy
import unittest

from qwen_alignment import QwenAlignmentError, normalize_aligned_words
from subtitle_processing import timed_words_to_chunks


def word(text, start, end):
    return {"word": text, "start_ts": start, "end_ts": end}


class QwenAlignmentTests(unittest.TestCase):
    def test_nfkc_variants_keep_original_spelling_punctuation_and_silence(self):
        text = "「１５！」 ｶﾞｰﾙｽﾞ？"
        words = [word("1", 2, 2.2), word("5", 2.2, 3), word("ガールズ", 8, 9)]
        before = copy.deepcopy(words)
        aligned, count = normalize_aligned_words(words, text, 30)
        self.assertEqual("".join(item["word"] for item in aligned), text)
        self.assertEqual(words, before)
        self.assertEqual(count, 0)
        cues = timed_words_to_chunks(aligned, [{"text": text, "start_ts": 0, "end_ts": 30}])
        self.assertEqual(cues, [{"text": "「１５！」", "start_ts": 2, "end_ts": 3},
                                {"text": "ｶﾞｰﾙｽﾞ？", "start_ts": 8, "end_ts": 9}])

    def test_combining_marks_jamo_case_and_ligatures_keep_source(self):
        cases = [("か\u3099", ["が"]), ("한", ["한"]), ("ＡbＣ", ["abc"]),
                 ("ﬁ!", ["f", "i"]), ("㍿", ["株式", "会社"])]
        for text, tokens in cases:
            with self.subTest(text=text):
                words = [word(token, i+1, i+1.5) for i, token in enumerate(tokens)]
                aligned, _ = normalize_aligned_words(words, text, 30)
                self.assertEqual("".join(item["word"] for item in aligned), text)
                self.assertTrue(all(item["end_ts"] > item["start_ts"] for item in aligned))

    def test_real_missing_or_changed_text_is_not_accepted(self):
        for original in ["１５６", "別の文"]:
            with self.assertRaises(QwenAlignmentError) as caught:
                normalize_aligned_words([word("15", 1, 2)], original, 30)
            self.assertEqual(caught.exception.reason, "text_mismatch")

    def test_one_quantization_tick_at_end_joins_nearby_word(self):
        words = [word("a", 29, 29.8), word("b", 30.08, 30.08)]
        aligned, count = normalize_aligned_words(words, "ab", 30)
        self.assertEqual(aligned, [word("ab", 29, 30)])
        self.assertEqual(count, 1)

    def test_bad_times_are_not_hidden_by_unicode_merge(self):
        for words, reason in [([word("f", 2, 3), word("i", 1, 2)], "overlap"),
                              ([word("fi", 1, 31)], "out_of_range"),
                              ([word("fi", 1, 1)], "all_collapsed"),
                              ([word("fi", float('nan'), 3)], "invalid_time"),
                              ([], "empty")]:
            with self.subTest(reason=reason), self.assertRaises(QwenAlignmentError) as caught:
                normalize_aligned_words(words, "ﬁ", 30)
            self.assertEqual(caught.exception.reason, reason)

    def test_boundary_word_never_extends_previous_word_across_silence(self):
        with self.assertRaises(QwenAlignmentError) as caught:
            normalize_aligned_words([word("a", 1, 2), word("b", 30, 30)], "ab", 30)
        self.assertEqual(caught.exception.reason, "boundary")

    def test_failed_validation_does_not_mutate_input(self):
        words = [word("first", 29, 30.08), word("wrong", 31, 32)]
        original = copy.deepcopy(words)
        with self.assertRaises(QwenAlignmentError):
            normalize_aligned_words(words, "firstwrong", 30)
        self.assertEqual(words, original)

    def test_window_message_has_reason_and_absolute_video_time(self):
        message = str(QwenAlignmentError("all_collapsed", (1400, 1430)))
        self.assertIn("23:20.000~23:50.000", message)
        self.assertIn("모든 단어", message)


if __name__ == "__main__":
    unittest.main()
