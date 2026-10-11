"""모델 없이 경계 소유권을 검사한다. 예제 문구는 실제 작품에서 가져오지 않는다."""

from copy import deepcopy
import random
import unittest

from acoustic_timing import display_units, resolve
from subtitle_processing import group_timed_words, timed_words_to_chunks, stitch_chunks
from qwen_alignment import normalize_aligned_words


def word(text, start, end, segment=1):
    return dict(text=text, start_ts=start, end_ts=end, _segment=segment)


def proposal(source, accepted=True, start=None, end=None):
    start = source[0]["start_ts"] if start is None else start
    end = max(c["end_ts"] for c in source) if end is None else end
    return dict(original=source,
                candidate=[word("".join(c["text"] for c in source), start, end, ("acoustic", start))],
                accepted=accepted, support_start=start+.1, support_end=end-.1, kind="phrase")


def public(cues):
    return [{k: v for k, v in c.items() if not k.startswith("_")} for c in cues]


class DisplayBoundaryTests(unittest.TestCase):
    def test_uncertainty_wins_even_if_an_upstream_stage_leaves_the_trusted_flag(self):
        for seam in (1.4, 1.8, 2, 2.3, 2.7, 3):
            before = [dict(word(t, i, i+.8), _timing_uncertain=True) for i, t in enumerate(("first", "yes", "word", "end"))]
            after = [dict(c, start_ts=c["start_ts"]+.1, end_ts=c["end_ts"]+.1) for c in before]
            expected = public(stitch_chunks(before, after, seam))
            for cue in before+after:
                cue["_timed_word"] = True
            self.assertEqual(public(stitch_chunks(before, after, seam)), expected)

    def test_estimated_qwen_word_never_becomes_a_confirmed_seam_anchor(self):
        words = [dict(word="初め", start_ts=1, end_ts=2), dict(word="末尾。", start_ts=4, end_ts=4),
                 dict(word="次。", start_ts=6, end_ts=7)]
        normalized, collapsed = normalize_aligned_words(words, "初め末尾。次。", 10)
        self.assertEqual(collapsed, 1)
        self.assertTrue(normalized[1]["_timing_uncertain"])
        chunks = timed_words_to_chunks(normalized, [word("初め末尾。次。", 1, 7)], engine="qwen", word_output=True)
        self.assertTrue(chunks[0]["_timed_word"])
        self.assertTrue(chunks[1]["_timing_uncertain"])
        self.assertNotIn("_timed_word", chunks[1])
        self.assertTrue(chunks[2]["_timed_word"])
        self.assertEqual("".join(c["text"] for c in chunks), "初め末尾。次。")

    def test_joined_collapsed_prefix_and_tail_keep_uncertainty(self):
        for text, raw in (
            ("今日です。", [("今", 1, 1), ("日です。", 1.1, 2)]),
            ("終了です。", [("終了", 1, 2), ("です。", 2.1, 2.1)]),
        ):
            normalized, _ = normalize_aligned_words([dict(word=t, start_ts=s, end_ts=e) for t, s, e in raw], text, 4)
            self.assertEqual(len(normalized), 1)
            self.assertTrue(normalized[0]["_timing_uncertain"])
            chunks = timed_words_to_chunks(normalized, [word(text, 1, 3)], engine="qwen", word_output=True)
            self.assertTrue(chunks[0]["_timing_uncertain"])
            self.assertNotIn("_timed_word", chunks[0])

    def test_acceptance_and_processing_batch_are_not_utterance_boundaries(self):
        for parts in (("明日の", "予定です。"), ("내일 ", "갑니다."), ("Tomorrow ", "we go.")):
            for accepted in (True, False):
                with self.subTest(parts=parts, accepted=accepted):
                    proposals = [proposal([word(parts[0], 1, 2)]),
                                 proposal([word(parts[1], 2, 3)], accepted)]
                    old = deepcopy(proposals)
                    current = group_timed_words(display_units(proposals, "legacy"))
                    candidate = group_timed_words(display_units(proposals, "source"))
                    self.assertEqual(len(current), 2)
                    self.assertEqual(public(candidate), [dict(text="".join(parts), start_ts=1, end_ts=3)])
                    self.assertEqual(proposals, old)

    def test_protected_policy_never_pulls_a_verified_onset_into_an_unverified_prefix(self):
        proposals = [proposal([word("前の部分", 1, 4)], False), proposal([word("続き。", 4.1, 6)])]
        self.assertEqual(len(group_timed_words(display_units(proposals, "source"))), 1)
        guarded = group_timed_words(display_units(proposals, "supported"))
        self.assertEqual(len(guarded), 2)
        self.assertEqual(guarded[1]["start_ts"], 4.1)

    def test_supported_neighbors_can_ignore_work_batch_ids_but_onset_only_cannot(self):
        proposals = [proposal([word("明日の", 1, 2)]), proposal([word("予定です。", 2, 3)])]
        self.assertEqual(len(group_timed_words(display_units(proposals, "supported"))), 1)
        proposals[1]["support_end_known"] = False
        self.assertEqual(len(group_timed_words(display_units(proposals, "supported"))), 2)

    def test_same_resolved_timestamps_are_used_and_no_character_time_is_invented(self):
        source = [word("あ", 1, 1.1), word("いうえ", 1.1, 2)]
        proposals = [proposal(source, start=1.3, end=2.1), proposal([word("お。", 2.4, 3)], False)]
        legacy, source = display_units(proposals, "legacy"), display_units(proposals)
        self.assertEqual(public(legacy), public(source))
        self.assertEqual(len(source), 2)
        self.assertEqual(source[0]["text"], "あいうえ")

    def test_sentence_native_turn_silence_and_overlap_remain_separate(self):
        for left, right in (
            (word("返事。", 1, 2), word("次。", 2, 3)),
            (word("「返事。」", 1, 2), word("次", 2, 3)),
            (word("返事", 1, 2, 1), word("次", 2, 3, 2)),
            (word("返事", 1, 2), word("次", 5, 6)),
            (word("返事", 1, 3), word("次", 2, 4)),
        ):
            with self.subTest(left=left, right=right):
                proposals = [proposal([left]), proposal([right])]
                self.assertEqual(len(group_timed_words(display_units(proposals), gap_threshold=.65)), 2)

    def test_reading_padding_does_not_bridge_a_supported_pause(self):
        proposals = [proposal([word("前半", 1, 2.24)]), proposal([word("後半", 2.33, 3.4)])]
        proposals[0]["support_end"] = 2
        proposals[1]["support_start"] = 2.65
        result = group_timed_words(display_units(proposals), gap_threshold=.65)
        self.assertEqual(len(result), 2)

    def test_onset_only_correction_does_not_claim_the_tail_is_acoustically_verified(self):
        item = proposal([word("不確かな末尾", 1, 2)])
        item.update(kind="rechecked", support_end_known=False)
        self.assertNotIn("_acoustic_end", display_units([item])[0])

    def test_mixed_source_boundary_inside_one_token_is_not_interpolated(self):
        item = proposal([word("あ", 1, 1.1, 1), word("いう", 1.1, 2, 2)])
        result = display_units([item])
        self.assertEqual(result[0]["_segment"], item["candidate"][0]["_segment"])
        self.assertEqual(len(result), 1)

    def test_unknown_source_boundary_is_not_erased(self):
        item = proposal([word("あいう", 1, 2, None)])
        self.assertEqual(display_units([item])[0]["_segment"], item["candidate"][0]["_segment"])

    def test_overlap_rejection_precedes_display_decision(self):
        original = [word("前の発言", 1, 2), word("次の発言", 2.2, 3)]
        proposals = [proposal(original[:1], start=1.5, end=2.8), proposal(original[1:], False)]
        legacy, accepted = resolve(proposals)
        self.assertEqual(accepted, 0)
        self.assertEqual(display_units(proposals), legacy)

    def test_grouping_obeys_size_budget_and_keeps_spaces_slashes_and_real_repeats(self):
        for texts in (("word / ",)*50, ("はい",)*150, ("네 ",)*120):
            proposals = [proposal([word(text, i*.2, (i+1)*.2)]) for i, text in enumerate(texts)]
            result = group_timed_words(display_units(proposals))
            self.assertEqual("".join(c["text"] for c in result), "".join(texts))
            self.assertTrue(all(c["end_ts"]-c["start_ts"] <= 12.001 for c in result))

    def test_randomized_acceptance_never_changes_text_times_or_input(self):
        rng = random.Random(1407)
        for _ in range(100):
            proposals = [proposal([word(text, i, i+.8, i//5)], rng.choice([True, False]))
                         for i, text in enumerate(("あ", "い、", "우 ", "word ", "次。")*10)]
            old = deepcopy(proposals)
            units = display_units(proposals)
            self.assertEqual(public(units), public(display_units(proposals, "legacy")))
            grouped = group_timed_words(units)
            self.assertEqual("".join(c["text"] for c in units), "".join(c["text"] for c in grouped))
            self.assertEqual(proposals, old)

    def test_unknown_policy_is_not_silently_applied(self):
        with self.assertRaises(ValueError):
            display_units([], "typo")


if __name__ == "__main__":
    unittest.main()
