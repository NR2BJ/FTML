import unittest

from subtitle_processing import chunks_to_vtt, find_gaps, merge_chunks, normalize_chunks


def cue(text, start, end):
    return {"text": text, "start_ts": start, "end_ts": end}


class SubtitleProcessingTests(unittest.TestCase):
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
