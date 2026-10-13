import unittest

from subtitle_processing import chunks_to_vtt, find_gaps, merge_chunks, normalize_chunks, timed_words_to_chunks, stitch_chunks, group_timed_words, stabilize_short_cues


def cue(text, start, end):
    return {"text": text, "start_ts": start, "end_ts": end}


class SubtitleProcessingTests(unittest.TestCase):
    def test_seam_short_uncertain_word_is_not_recovered_twice(self):
        for text in ("민수", "出口", "ok", "yes"):
            for old_uncertain in (False, True):
                with self.subTest(text=text, old_uncertain=old_uncertain):
                    word = lambda text, start, end, uncertain=False: dict(
                        cue(text, start, end), _segment="qwen",
                        **({"_timing_uncertain": True} if uncertain else {"_timed_word": True}))
                    existing = [word("앞", 1, 1.4), word(text+".", 4.44, 4.52, old_uncertain)]
                    incoming = [word("앞", 1.05, 1.45), word(text, 4.4, 4.48, not old_uncertain),
                                word("다음", 5.28, 6)]
                    result = stitch_chunks(existing, incoming, 2.5)
                    self.assertEqual([c["text"] for c in result], ["앞", text, "다음"])
                    self.assertEqual((result[1]["start_ts"], result[1]["end_ts"]), (4.4, 4.48))

    def test_seam_short_match_must_overlap_and_be_unambiguous(self):
        from subtitle_processing import _seam_text_coverage
        word = lambda start, end: dict(cue("네", start, end), _timing_uncertain=True, _segment="qwen")
        for left, right in [([word(4, 4.08)], [word(4.08, 4.16)]),
                            ([word(4, 4.08)], [word(4.08-1e-12, 4.16)]),
                            ([word(4, 4.08), word(4.02, 4.1)], [word(4.04, 4.12)]),
                            ([word(4.04, 4.12)], [word(4, 4.08), word(4.02, 4.1)])]:
            self.assertEqual(_seam_text_coverage(left, right, 2.5), {})

    def test_seam_short_coverage_does_not_match_partial_or_untimed_text(self):
        from subtitle_processing import _seam_text_coverage
        for left, right in [(dict(cue("ok", 1, 1.1), _timing_uncertain=True),
                             dict(cue("okay", 1.04, 1.14), _timed_word=True)),
                            (cue("ok", 1, 1.1), cue("ok", 1.04, 1.14))]:
            self.assertEqual(_seam_text_coverage([left], [right], 2.5), {})

    def test_seam_short_duplicate_recovery_is_symmetric(self):
        word = lambda text, start, end: dict(cue(text, start, end), _timing_uncertain=True, _segment="qwen")
        existing = [word("네", 4.4, 4.48), dict(cue("확인", 6.9, 7.4), _timed_word=True)]
        incoming = [word("네.", 4.44, 4.52), dict(cue("확인", 6.95, 7.45), _timed_word=True), word("다음", 8, 9)]
        self.assertEqual(stitch_chunks(existing, incoming, 5), existing+[incoming[-1]])

    def test_seam_does_not_recover_a_late_duplicate_with_different_tokenization(self):
        word = lambda text, start, end: dict(cue(text, start, end), _timed_word=True, _segment="qwen")
        existing = [word("説明", 1, 1.4), word("を", 1.4, 1.6), word("聞く", 1.6, 2),
                    word("ところです。", 3, 3.08)]
        incoming = [word("説明", 1.05, 1.45), word("を", 1.45, 1.65), word("聞く", 1.65, 2.05),
                    word("ところ", 2.05, 2.7), word("です。", 3.8, 3.88), word("次。", 4, 5)]
        result = stitch_chunks(existing, incoming, 1.5)
        self.assertEqual("".join(c["text"] for c in result), "説明を聞くところです。次。")

    def test_seam_text_recovery_keeps_genuinely_missing_and_repeated_utterances(self):
        word = lambda text, start, end: dict(cue(text, start, end), _timed_word=True, _segment="qwen")
        existing = [word("説明", 1, 1.4), word("を", 1.4, 1.6), word("聞く", 1.6, 2),
                    word("あっ", 2.2, 2.4), word("はい", 3, 3.2), word("はい", 4, 4.2)]
        incoming = [word("説明", 1.05, 1.45), word("を", 1.45, 1.65), word("聞く", 1.65, 2.05),
                    word("次。", 5, 6)]
        result = stitch_chunks(existing, incoming, 1.5)
        self.assertEqual("".join(c["text"] for c in result), "説明を聞くあっはいはい次。")

    def test_point_word_never_uses_unrelated_segment_start_as_onset(self):
        for engine in ("whisper", "qwen"):
            for first, second in [("Hello ", "there."), ("오늘 ", "갑니다."), ("明日", "です。")]:
                with self.subTest(engine=engine, first=first):
                    words = [dict(word=first, start_ts=8, end_ts=8),
                             dict(word=second, start_ts=8.2, end_ts=9)]
                    result = timed_words_to_chunks(words, [cue(first+second, 0, 10)], engine=engine)
                    self.assertEqual(result[0]["start_ts"], 8)
                    self.assertEqual("".join(c["text"] for c in result).replace(" ", ""), (first+second).replace(" ", ""))

    def test_coincident_point_prefix_does_not_discard_good_later_times(self):
        words = [dict(word="今", start_ts=8, end_ts=8), dict(word="日", start_ts=8, end_ts=8.5),
                 dict(word="次。", start_ts=12, end_ts=13)]
        result = timed_words_to_chunks(words, [cue("今日次。", 0, 15)], word_output=True)
        self.assertEqual([(c["text"], c["start_ts"], c["end_ts"]) for c in result], [("今日", 8, 8.5), ("次。", 12, 13)])
        self.assertTrue(result[0]["_timing_uncertain"])
        self.assertNotIn("_timed_word", result[0])

    def test_point_tail_does_not_fill_rest_of_segment(self):
        words = [dict(word="終わり", start_ts=2, end_ts=3), dict(word="です。", start_ts=3, end_ts=3)]
        self.assertEqual(timed_words_to_chunks(words, [cue("終わりです。", 0, 20)]), [cue("終わりです。", 2, 3)])

    def test_unrelated_or_reversed_point_is_not_a_timing_anchor(self):
        for points in [[dict(word="unrelated", start_ts=8, end_ts=8)],
                       [dict(word="a", start_ts=9, end_ts=9), dict(word="b", start_ts=8, end_ts=8)]]:
            result = timed_words_to_chunks(points + [dict(word="c", start_ts=10, end_ts=11)], [cue("abc", 0, 12)])
            self.assertEqual(result[0]["start_ts"], 0)

    def test_first_word_crossing_segment_boundary_keeps_its_timing_evidence(self):
        words = [dict(word="前。", start_ts=1, end_ts=2),
                 dict(word="次", start_ts=2, end_ts=5),
                 dict(word="です。", start_ts=5, end_ts=6)]
        result = timed_words_to_chunks(words, [cue("前。", 1, 2.3), cue("次です。", 2.3, 6.2)], word_output=True)
        self.assertEqual([c["text"] for c in result], ["前。", "次", "です。"])
        self.assertEqual([(c["start_ts"], c["end_ts"]) for c in result], [(1, 2), (2.3, 5), (5, 6)])
        self.assertTrue(all(c.get("_timed_word") for c in result))

    def test_unrelated_word_times_outside_segment_still_fall_back(self):
        self.assertEqual(timed_words_to_chunks([dict(word="hello", start_ts=20, end_ts=21)], [cue("hello", 1, 2)]),
                         [cue("hello", 1, 2)])

    def test_word_seam_keeps_one_copy_of_short_words_and_whole_boundary_words(self):
        word = lambda text, start, end: dict(cue(text, start, end), _timed_word=True, _segment="qwen")
        existing = [word("あと", 25.28, 25.6), word("気", 25.6, 26.16), word("が", 26.16, 26.24),
                    word("利い", 26.24, 27.52), word("て清素", 27.52, 27.68), word("で", 27.68, 27.84),
                    word("活発", 27.84, 28.48), word("で。", 28.48, 29.04)]
        incoming = [word("あと", 25, 25.56), word("気", 25.96, 26.2), word("が", 26.2, 26.28),
                    word("効いて", 26.44, 26.6), word("清掃", 27.24, 27.64), word("で", 27.64, 27.8),
                    word("活発", 27.8, 28.44), word("で。", 28.68, 29), word("次。", 30, 31)]
        result = group_timed_words(stitch_chunks(existing, incoming, 27.5), gap_threshold=0.65)
        self.assertEqual([c["text"] for c in result], ["あと気が利いて清素で活発で。", "次。"])

    def test_word_stitch_keeps_same_pass_overlapping_speakers_and_repeated_answers(self):
        original = [dict(cue(text, start, end), _timed_word=True, _segment="qwen") for text, start, end in
                    [("はい", 1, 1.1), ("はい", 1.04, 1.14), ("別人", 1.06, 1.5), ("はい", 3, 3.1)]]
        self.assertEqual(stitch_chunks(original, [cue("次", 5, 6)], 4), original+[cue("次", 5, 6)])

    def test_deferred_grouping_preserves_english_spaces_and_untimed_utterances(self):
        segments = [cue("hello there", 1, 3), cue("next sentence", 3, 4)]
        words = [dict(word="hello", start_ts=1, end_ts=2), dict(word=" there", start_ts=2, end_ts=3)]
        for source in [words, []]:
            result = group_timed_words(timed_words_to_chunks(source, segments, word_output=True))
            self.assertEqual([c["text"] for c in result], ["hello there", "next sentence"])

    def test_native_utterances_remain_separate_without_punctuation(self):
        segments = [cue("三時です", 0, 1), cue("はい", 1, 1.2), cue("入口はどこ", 1.2, 2.5)]
        words = [{"word": c["text"], "start_ts": c["start_ts"], "end_ts": c["end_ts"]} for c in segments]
        self.assertEqual(timed_words_to_chunks(words, segments), segments)

    def test_model_specific_pause_does_not_join_sentences_or_long_silence(self):
        words = [dict(word="続き", start_ts=0, end_ts=1), dict(word="です。", start_ts=1.5, end_ts=2),
                 dict(word="次。", start_ts=2.1, end_ts=3), dict(word="後。", start_ts=4, end_ts=5)]
        segments = [cue("続きです。次。後。", 0, 5)]
        self.assertEqual(len(timed_words_to_chunks(words, segments)), 4)
        self.assertEqual(timed_words_to_chunks(words, segments, engine="qwen"),
                         [cue("続きです。", 0, 2), cue("次。", 2.1, 3), cue("後。", 4, 5)])

    def test_soft_length_limit_does_not_cut_japanese_fragments(self):
        parts = [cue(c, i*0.5, (i+1)*0.5) for i, c in enumerate("明日の仕事について説明します")]
        result = group_timed_words(parts)
        self.assertEqual(result, [cue("明日の仕事について説明します", 0, len(parts)*0.5)])

    def test_length_limit_still_splits_at_spaces_and_has_hard_bound(self):
        english = [cue("word ", i*0.5, (i+1)*0.5) for i in range(30)]
        self.assertGreater(len(group_timed_words(english)), 1)
        continuous = [cue("あ", i*0.2, (i+1)*0.2) for i in range(150)]
        result = group_timed_words(continuous)
        self.assertEqual("".join(c["text"] for c in result), "あ"*150)
        self.assertTrue(all(c["end_ts"]-c["start_ts"] <= 12.001 for c in result))

    def test_quotes_keep_sentence_boundary_and_slashes_are_not_removed(self):
        result = group_timed_words([cue("「はい。」", 0, 1), cue("A / B", 1, 2)])
        self.assertEqual(result, [cue("「はい。」", 0, 1), cue("A / B", 1, 2)])

    def test_qwen_keeps_pause_after_clause_but_joins_flash_fragment(self):
        clauses = [cue("田中さん、", 0, 0.5), cue("いつですか？", 1.1, 2)]
        self.assertEqual(group_timed_words(clauses, gap_threshold=0.65), clauses)
        fragment = [cue("あ、", 0, 0.08), cue("続き。", 0.56, 2)]
        self.assertEqual(group_timed_words(fragment, gap_threshold=0.65), [cue("あ、続き。", 0, 2)])

    def test_short_hold_never_advances_start_or_covers_next_utterance(self):
        original = [cue("a", 1, 1.08), cue("b", 3, 3.16), cue("c", 3.4, 3.48), cue("end", 9.9, 9.98)]
        result = stabilize_short_cues(original, 10)
        self.assertAlmostEqual(result[0]["end_ts"], 1.63)
        self.assertAlmostEqual(result[1]["end_ts"], 3.36)
        self.assertAlmostEqual(result[-1]["end_ts"], 10)
        for before, after in zip(original, result):
            self.assertEqual(before["text"], after["text"])
            self.assertEqual(before["start_ts"], after["start_ts"])
            self.assertLessEqual(after["end_ts"]-before["end_ts"], 0.550001)
        self.assertEqual(original[0]["end_ts"], 1.08)

    def test_short_hold_preserves_overlaps_and_long_silence(self):
        cues = [cue("speaker one", 0, 3), cue("speaker two", 2, 2.1), cue("speaker three", 2.5, 2.6), cue("later", 20, 22)]
        self.assertEqual(stabilize_short_cues(cues, 30), cues)

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
