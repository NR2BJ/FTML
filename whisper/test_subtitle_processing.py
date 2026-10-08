import unittest

from subtitle_processing import chunks_to_vtt, find_gaps, merge_chunks, normalize_chunks, timed_words_to_chunks


def cue(text, start, end):
    return {"text": text, "start_ts": start, "end_ts": end}


class SubtitleProcessingTests(unittest.TestCase):
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
