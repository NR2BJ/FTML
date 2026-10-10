import copy
import threading
import unittest

from qwen_alignment import QwenAlignmentError, normalize_aligned_words, refine_aligned_sentences, alignment_issue_count
from subtitle_processing import timed_words_to_chunks


def word(text, start, end):
    return {"word": text, "start_ts": start, "end_ts": end}


class QwenAlignmentTests(unittest.TestCase):
    def test_quick_english_words_are_not_treated_as_collapsed_cjk_phrases(self):
        self.assertEqual(alignment_issue_count([word("hello", 0, .2)]), 0)
        self.assertEqual(alignment_issue_count([word("あいうえ", 0, .16)]), 1)
        self.assertEqual(alignment_issue_count([word("가나다라", 0, .16)]), 1)

    def refinement_source(self):
        words = [word("Before.", 0, .5), word("Alpha ", 1, 1.4), word("beta ", 2.8, 2.8),
                 word("gamma.", 2.8, 2.8), word("Next.", 2.8, 3.2)]
        return words, "Before.Alpha beta gamma.Next."

    def test_collapsed_sentence_is_realigned_before_merging_with_next_speaker(self):
        words, text = self.refinement_source()
        original = copy.deepcopy(words)
        calls = []
        def align(source, start, end):
            calls.append((source, start, end))
            return [word("Alpha", .3, .7), word("beta", .8, 1.15), word("gamma", 1.2, 1.6)]
        result, attempts, refined = refine_aligned_sentences(words, text, 4, align)
        self.assertEqual((attempts, refined), (1, 1))
        self.assertEqual(calls, [("Alpha beta gamma.", .75, 2.8)])
        self.assertEqual(result[0], words[0])
        self.assertEqual(result[-1], words[-1])
        self.assertEqual("".join(w["word"] for w in result), text)
        self.assertLess(result[-2]["end_ts"], result[-1]["start_ts"])
        self.assertEqual(normalize_aligned_words(result, text, 4)[1], 0)
        self.assertEqual(words, original)

    def test_failed_changed_or_unstable_retry_keeps_original_words(self):
        words, text = self.refinement_source()
        for retry in [[], [word("wrong", .1, .5)],
                      [word("Alpha beta gamma", 1, 1)],
                      [word("Alpha", 1.4, 1.6), word("beta", 1.6, 1.8), word("gamma", 1.8, 2)],
                      [word("Alpha beta gamma", 0, 20)]]:
            with self.subTest(retry=retry):
                result, attempts, refined = refine_aligned_sentences(words, text, 4, lambda *args: retry)
                self.assertEqual(result, words)
                self.assertEqual((attempts, refined), (1, 0))
        def failed(*args):
            raise RuntimeError("optional retry failed")
        self.assertEqual(refine_aligned_sentences(words, text, 4, failed), (words, 1, 0))

    def test_retries_are_bounded_and_normal_sentences_are_not_reprocessed(self):
        words = [word("Normal.", 0, 1)]
        for i in range(3):
            words.extend([word("A", 2+i*2, 2.4+i*2), word("b.", 3+i*2, 3+i*2)])
        text = "".join(w["word"] for w in words)
        calls = []
        def align(*args):
            calls.append(args)
            return []
        result, attempts, refined = refine_aligned_sentences(words, text, 9, align)
        self.assertEqual((attempts, refined), (2, 0))
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(source == "Ab." and end-start <= 12 for source, start, end in calls))
        self.assertEqual(result, words)
        self.assertEqual(refine_aligned_sentences(words[:1], "Normal.", 2, align)[1:], (0, 0))

    def test_cancelled_refinement_is_not_swallowed_as_optional_failure(self):
        words, text = self.refinement_source()
        cancel = threading.Event()
        def align(*args):
            cancel.set()
            return [word("Alpha beta gamma", .2, 1.2)]
        with self.assertRaises(InterruptedError):
            refine_aligned_sentences(words, text, 4, align, cancel)

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
