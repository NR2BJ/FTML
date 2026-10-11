import copy
import unittest

from acoustic_timing import batches, corroborate_evidence, japanese_text, letters, propose, resolve, token_spans


def word(text, start, end):
    return dict(text=text, start_ts=start, end_ts=end, _segment="original")


def point(first, last, start, end, score=-.1, agrees=True):
    return dict(first=first, last=last, start=start, end=end, score=score, agrees=agrees)


class AcousticTimingTests(unittest.TestCase):
    def test_recheck_requires_all_times_and_token_boundaries_to_agree(self):
        original=[point(0,2,1,1.1),point(2,3,1.5,1.6,-2,False)]
        repeated=[point(0,2,1.01,1.11,-2,False),point(2,3,1.51,1.61)]
        result=corroborate_evidence(original,repeated)
        self.assertTrue(all(p["agrees"] for p in result))
        self.assertEqual([p["start"] for p in result],[1,1.5])
        self.assertFalse(original[-1]["agrees"])
        for broken in ([repeated[0]], [repeated[0],dict(repeated[1],start=3,end=3.1)],
                       [repeated[0],dict(repeated[1],first=1)], [repeated[0],dict(repeated[1],score=float("nan"))]):
            self.assertIsNone(corroborate_evidence(original,broken))

    def test_two_weak_paths_do_not_turn_into_supported_speech(self):
        points=[point(0,2,1,1.1,-3,False)]
        self.assertFalse(corroborate_evidence(points,points)[0]["agrees"])

    def test_uncertain_interjection_does_not_reject_the_following_supported_clause(self):
        source = [word("ああ、", 1, 1.08), word("いうえ", 2.5, 3.4), word("お。", 4.2, 4.28),
                  word("かきく。", 4.3, 5.5)]
        evidence = [point(0, 1, 1.8, 1.82, -3, False), point(1, 2, 1.95, 1.97),
                    point(2, 5, 2.5, 2.7), point(5, 6, 3.1, 3.15), point(6, 9, 3.9, 4.2)]
        result, accepted = resolve(propose(source, evidence, 10))
        self.assertEqual(accepted, 2)
        self.assertEqual(result[0], source[0])
        self.assertEqual([c["text"] for c in result], ["ああ、", "いうえお。", "かきく。"])
        self.assertLess(result[1]["end_ts"], result[2]["start_ts"])

    def test_supported_onset_can_move_without_claiming_an_uncertain_tail_is_aligned(self):
        source = [word("あ", 1, 2.3), word("い", 2.3, 2.6), word("うえ", 2.6, 3)]
        evidence = [point(0, 1, 2.2, 2.22), point(1, 2, 2.4, 2.42),
                    point(2, 4, 2.7, 2.8, -2.5, False)]
        proposals = propose(source, evidence, 10)
        result, accepted = resolve(proposals)
        self.assertEqual(accepted, 1)
        self.assertEqual(proposals[0]["kind"], "onset")
        self.assertGreater(result[0]["start_ts"], 2)
        self.assertEqual(result[0]["end_ts"], 3)
        self.assertEqual(result[0]["text"], "あいうえ")

    def test_one_supported_character_cannot_move_an_uncertain_phrase(self):
        source = [word("あ", 1, 2.3), word("いう", 2.3, 3)]
        result, accepted = resolve(propose(source, [point(0, 1, 2.2, 2.22),
                                                   point(1, 3, 2.5, 2.6, -4, False)], 10))
        self.assertEqual(accepted, 0)
        self.assertEqual(result, source)

    def test_language_gate_does_not_send_korean_or_english_to_japanese_model(self):
        for language, text, expected in [
            ("ko", "오늘은 화창합니다", False), ("en", "Hello, how are you?", False),
            ("auto", "한국어 and English", False), ("ja", "あいうえおかきくけこ", True),
            ("auto", "あいうえおかきくけこ", True), ("ko", "あいうえおかきくけこ", False),
        ]:
            self.assertEqual(japanese_text([word(text, 0, 1)], language), expected)

    def test_normalization_is_only_for_matching(self):
        self.assertEqual(letters("ＡＢＣ、１２！"), "abc12")
        self.assertEqual(token_spans("abcd", ["ab", "c", "d"]), [(0, 2), (2, 3), (3, 4)])
        for pieces in (["ab"], ["ab", "<unk>"], ["ac", "bd"], ["", "abcd"]):
            with self.assertRaises(ValueError):
                token_spans("abcd", pieces)

    def test_independent_evidence_can_move_early_phrase_without_rewriting(self):
        source = [word("あい", 1, 3), word("うえ。", 3, 4)]
        before = copy.deepcopy(source)
        evidence = [point(0, 2, 3.1, 3.2), point(2, 4, 3.4, 3.5)]
        result, accepted = resolve(propose(source, evidence, 10))
        self.assertEqual(accepted, 1)
        self.assertGreater(result[0]["start_ts"], 2.8)
        self.assertEqual(result[0]["text"], "あいうえ。")
        self.assertEqual(source, before)

    def test_zero_length_native_tail_is_not_an_eighty_ms_display(self):
        source = [word("あいう", 1, 2), word("えお。", 3, 3.08)]
        result, accepted = resolve(propose(source, [point(0, 3, 1.6, 1.7), point(3, 5, 1.9, 2)], 10))
        self.assertEqual(accepted, 1)
        self.assertEqual(result[0]["text"], "あいうえお。")
        self.assertGreater(result[0]["end_ts"] - result[0]["start_ts"], .6)
        self.assertLess(result[0]["end_ts"], 2.5)

    def test_weak_forced_path_is_not_evidence_and_does_not_drop_text(self):
        source = [word("あいうえ。", 1, 2)]
        for evidence in ([point(0, 4, 3, 3.2, -9)], [point(0, 4, 3, 3.2, agrees=False)]):
            result, accepted = resolve(propose(source, evidence, 10))
            self.assertEqual(accepted, 0)
            self.assertEqual(result, source)

    def test_shared_subword_does_not_allocate_each_character_a_fake_time(self):
        source = [word("あ", 1, 1.1), word("いうえ。", 1.1, 2)]
        result, accepted = resolve(propose(source, [point(0, 4, 1.3, 1.4)], 10))
        self.assertEqual(accepted, 1)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["text"], "あいうえ。")

    def test_pause_remains_empty_and_two_speakers_remain_separate(self):
        source = [word("あいう。", 1, 2), word("えおか。", 4, 5)]
        result, accepted = resolve(propose(source, [point(0, 3, 1.3, 1.5), point(3, 6, 4.3, 4.5)], 10))
        self.assertEqual(accepted, 2)
        self.assertGreater(result[1]["start_ts"] - result[0]["end_ts"], 2)

    def test_crossing_unchanged_neighbor_reverts_instead_of_clipping(self):
        original = [word("あいう。", 1, 2), word("えおか。", 3, 4)]
        proposals = [dict(original=original[:1], candidate=[word("あいう。", 3, 3.9)], accepted=True),
                     dict(original=original[1:], candidate=[], accepted=False)]
        result, accepted = resolve(proposals)
        self.assertEqual(accepted, 0)
        self.assertEqual(result, original)

    def test_existing_overlap_cannot_allow_a_new_reversed_speaker_order(self):
        original = [word("あいう。", 0, 10), word("えおか。", 1, 2)]
        proposals = [dict(original=original[:1], candidate=[word("あいう。", 4, 5)], accepted=True,
                          support_start=4.2, support_end=4.8),
                     dict(original=original[1:], candidate=[], accepted=False)]
        result, accepted = resolve(proposals)
        self.assertEqual(accepted, 0)
        self.assertEqual(result, original)

    def test_overlapping_native_words_are_not_folded_into_one_acoustic_run(self):
        original = [word("あいう", 0, 4), word("えおか", 1, 2)]
        result, accepted = resolve(propose(original, [point(0, 3, 1.6, 1.8), point(3, 6, 2, 2.2)], 10))
        self.assertEqual(accepted, 0)
        self.assertEqual(result, original)

    def test_only_display_padding_can_be_reduced_next_to_an_unchanged_word(self):
        original = [word("あいう。", 1, 2), word("えお。", 2.2, 3)]
        proposals = [dict(original=original[:1], candidate=[word("あいう。", 1, 2.3)], accepted=True,
                          support_start=1.2, support_end=2.1),
                     dict(original=original[1:], candidate=[], accepted=False)]
        result, accepted = resolve(proposals)
        self.assertEqual(accepted, 1)
        self.assertEqual(result[0]["end_ts"], 2.2)
        self.assertEqual(result[1], original[1])

    def test_native_turn_boundaries_survive_even_without_punctuation(self):
        source = [dict(word("あいう", 1, 2), _segment=1), dict(word("えおか", 2.1, 3), _segment=2)]
        result, accepted = resolve(propose(source, [point(0, 3, 1.2, 1.8), point(3, 6, 2.2, 2.8)], 10))
        self.assertEqual(len(result), 2)
        self.assertEqual(accepted, 2)
        self.assertLessEqual(result[0]["end_ts"], result[1]["start_ts"])

    def test_new_boundary_must_not_expose_an_unreliable_short_fragment(self):
        original = [dict(word("あいう", 1, 2), _segment="qwen"),
                    dict(word("え", 2.5, 2.58), _segment="qwen")]
        proposals = [dict(original=original[:1], candidate=[word("あいう", 1.1, 1.8)], accepted=True,
                          support_start=1.2, support_end=1.7),
                     dict(original=original[1:], candidate=[], accepted=False)]
        result, accepted = resolve(proposals)
        self.assertEqual(accepted, 0)
        self.assertEqual(result, original)

    def test_boundary_uncertainty_does_not_discard_a_later_supported_sentence(self):
        source = [word("あいう。", 0, .5), word("えおか。", 1, 2)]
        result, accepted = resolve(propose(source, [point(0, 3, -.2, -.1, agrees=False),
                                                  point(3, 6, 1.2, 1.8)], 10))
        self.assertEqual(accepted, 1)
        self.assertEqual(result[0], source[0])

    def test_incomplete_nonfinite_reversed_and_boundary_evidence_is_rejected(self):
        for evidence in ([point(0, 2, 1, 2)], [point(1, 4, 1, 2)], [point(0, 4, 1, float("nan"))],
                         [point(0, 4, -1, 2)], [point(0, 4, 1, 11)],
                         [point(0, 2, 2, 3), point(2, 4, 1, 2)]):
            with self.assertRaises(ValueError):
                propose([word("あいうえ。", 0, 4)], evidence, 10)

    def test_batching_has_no_duplicate_or_omitted_text(self):
        source = [word("あいう。", i, i + 1) for i in range(60)]
        result = list(batches(source, 60))
        self.assertEqual([c for items, _, _ in result for c in items], source)
        self.assertTrue(all(end - start <= 30 for _, start, end in result))

    def test_batching_prefers_a_sentence_end_before_the_memory_limit(self):
        source = [word("あいう", i, i + 1) for i in range(35)]
        source[20]["text"] += "。"
        result = list(batches(source, 35))
        self.assertEqual(result[0][0][-1], source[20])
        self.assertEqual(result[1][0][0], source[21])


if __name__ == "__main__":
    unittest.main()
