import unittest

from subtitle_processing import chunks_to_vtt, find_gaps, merge_chunks, normalize_chunks, timed_words_to_chunks, stitch_chunks


def cue(text, start, end):
    return {"text": text, "start_ts": start, "end_ts": end}


class SubtitleProcessingTests(unittest.TestCase):
    def test_one_bad_segment_does_not_reset_good_segment_timing(self):
        words = [{"word":"first", "start_ts":2, "end_ts":3}, {"word":"mismatch", "start_ts":7, "end_ts":8}]
        self.assertEqual(timed_words_to_chunks(words, [cue("first",0,4),cue("second",6,10)]), [cue("first",2,3),cue("second",6,10)])

    def test_invalid_word_keeps_neighboring_word_time(self):
        words = [{"word":"hello!", "start_ts":3, "end_ts":4}, {"word":"next", "start_ts":float("nan"), "end_ts":9}]
        result = timed_words_to_chunks(words,[cue("hello! next",0,10)])
        self.assertEqual(result[0],cue("hello!",3,4))
        self.assertEqual("".join(c["text"] for c in result).replace(" ",""),"hello!next")

    def test_quotes_and_original_spelling_are_preserved(self):
        words = [{"word":"はい", "start_ts":2, "end_ts":3}]
        self.assertEqual(timed_words_to_chunks(words,[cue("「はい。」",0,4)]), [cue("「はい。」",2,3)])

    def test_recovery_cannot_add_different_dialogue_over_existing(self):
        result = merge_chunks([cue("actual",10,12)],[cue("thanks",10,12),cue("new",15,16)],recovery=True)
        self.assertEqual(result,[cue("actual",10,12),cue("new",15,16)])

    def test_stitch_does_not_stack_two_inferences_of_same_window(self):
        result = stitch_chunks([cue("first version",24,28)],[cue("second version",24.2,28.2),cue("next",29,30)],27.5)
        self.assertEqual(result,[cue("first version",24,28),cue("next",29,30)])

    def test_stitch_retains_words_missed_by_one_pass(self):
        existing = [cue("a",24,25),cue("b",28,29)]
        self.assertEqual(stitch_chunks(existing,[],27.5),existing)
        self.assertEqual(stitch_chunks(existing,[cue("new",26,27),cue("c",31,32)],27.5),
                         [cue("a",24,25),cue("new",26,27),cue("b",28,29),cue("c",31,32)])

    def test_word_boundaries_do_not_fill_silence(self):
        result = timed_words_to_chunks([
            {"word": "hello", "start_ts": 2, "end_ts": 2.5},
            {"word": " there", "start_ts": 2.55, "end_ts": 3},
            {"word": " next", "start_ts": 7, "end_ts": 8},
        ], [cue("hello there next", 0, 10)], offset=100)
        self.assertEqual(result, [cue("hello there", 102, 103), cue("next", 107, 108)])

    def test_missing_word_timing_preserves_full_sentence(self):
        segment = [cue("日本語の台詞", 1, 4)]
        for words in [[], [{"word": "日本語", "start_ts": 1, "end_ts": 2}], [{"word": "日本語の台詞", "start_ts": 2, "end_ts": 1}]]:
            self.assertEqual(timed_words_to_chunks(words, segment), segment)

    def test_word_timing_preserves_cjk_and_zero_length_punctuation(self):
        words = [{"word": "はい", "start_ts": 1, "end_ts": 2}, {"word": "。", "start_ts": 2, "end_ts": 2}]
        self.assertEqual(timed_words_to_chunks(words, [cue("はい。", 0, 3)]), [cue("はい。", 1, 2)])

    def test_real_dialogue_and_long_cues_survive(self):
        chunks = [cue(text, i*40, i*40+30) for i, text in enumerate(
            ["おやすみなさい", "お疲れ様でした", "No", "はい", "はい", "はい"])]
        self.assertEqual(chunks_to_vtt(chunks).count("-->"), len(chunks))

    def test_overlap_only_removes_same_dialogue_at_same_time(self):
        previous = [cue("first", 0, 10), cue("yes", 10, 11)]
        incoming = [cue("different speaker", 2, 5), cue("yes", 10.1, 11.1), cue("yes", 12, 13)]
        result = merge_chunks(previous, incoming)
        self.assertEqual([item["text"] for item in result], ["first", "different speaker", "yes", "yes"])

    def test_repetition_within_one_pass_is_not_deduplicated(self):
        chunks = [cue("yes", 0, 1), cue("yes", 0.1, 1.1)]
        self.assertEqual(merge_chunks([], chunks), chunks)

    def test_missing_all_speech_still_has_a_recovery_gap(self):
        self.assertEqual(find_gaps([], 100, 15), [(0, 100)])

    def test_nested_cues_do_not_create_false_gaps(self):
        self.assertEqual(find_gaps([cue("long", 0, 50), cue("short", 10, 11)], 60, 15), [])

    def test_invalid_times_are_rejected_without_fabrication(self):
        chunks = [cue("bad", 2, 1), cue("bad", float("nan"), 3), cue("valid", 2, 4)]
        self.assertEqual(normalize_chunks(chunks), [cue("valid", 2, 4)])


if __name__ == "__main__":
    unittest.main()
