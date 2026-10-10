import unittest
from speech_observer import refine_whisper_onsets, refine_whisper_prefixes
from subtitle_processing import timed_words_to_chunks, group_timed_words

def word(text, start, end):
    return dict(text=text, start_ts=start, end_ts=end, _segment=(0, 1), _timed_word=True)

class SpeechBoundaryTests(unittest.TestCase):
    def test_crossing_model_segment_boundary_can_still_refine_long_silence(self):
        source = [dict(word="次", start_ts=4.5, end_ts=7.6), dict(word="です", start_ts=7.6, end_ts=8)]
        words = timed_words_to_chunks(source, [dict(text="次です", start_ts=4.86, end_ts=8.1)], word_output=True)
        refined, count = refine_whisper_onsets(words, [(1, 5.2), (7.3, 8.2)])
        self.assertEqual(count, 1)
        self.assertAlmostEqual(refined[0]["start_ts"], 7.22)
        # 이전 발화가 길게 겹치거나 문장 중간의 단어이면 보정하지 않는다.
        self.assertEqual(refine_whisper_onsets(words, [(1, 6), (7.3, 8.2)]), (words, 0))
        middle = [dict(words[0], text="앞", start_ts=1, end_ts=2)] + words
        self.assertEqual(refine_whisper_onsets(middle, [(1, 5.2), (7.3, 8.2)]), (middle, 0))
        refined, count = refine_whisper_onsets(words, [(1, 4.4), (7.3, 8.2)])
        self.assertEqual(count, 1)
        self.assertGreater(group_timed_words(refined)[0]["start_ts"], 6.8)
        self.assertEqual("".join(w["text"] for w in refined), "次です")

    def test_silence_spread_over_two_initial_fragments_is_not_shown_early(self):
        source = [word("説", 7.08, 8.34), word("明", 8.34, 10.94), word("します", 10.94, 11.86)]
        result, count = refine_whisper_prefixes(source, [(1, 10), (10.3, 12.5)])
        self.assertEqual(count, 1)
        self.assertAlmostEqual(result[0]["start_ts"], 10.22)
        self.assertEqual(result[0]["end_ts"], 10.94)
        self.assertEqual(result[-1], source[-1])
        self.assertEqual("".join(w["text"] for w in result), "説明します")
        self.assertEqual(len(group_timed_words(result)), 1)
        self.assertEqual(source[0]["start_ts"], 7.08)

    def test_prefix_refinement_needs_silence_and_never_crosses_sentences(self):
        source = [word("説", 7.08, 8.34), word("明", 8.34, 10.94)]
        for spans in [[], [(1, 12.5)], [(1, 10.2), (10.3, 12.5)], [(1, 8), (8.5, 12.5)]]:
            self.assertEqual(refine_whisper_prefixes(source, spans), (source, 0))
        for changed in [[dict(source[0], text="説。"), source[1]],
                        [dict(source[0], text="あ、"), source[1]],
                        [dict(source[0], text="sing"), dict(source[1], text="along")],
                        [source[0], dict(source[1], _segment=(0, 2))],
                        [{k:v for k,v in w.items() if k != "_timed_word"} for w in source]]:
            self.assertEqual(refine_whisper_prefixes(changed, [(1, 10), (10.3, 12.5)]), (changed, 0))

    def test_long_leading_silence_is_not_part_of_first_word(self):
        source = [word('first', 2, 11), word('next', 11, 12)]
        result, count = refine_whisper_onsets(source, [(10, 12)])
        self.assertEqual(count, 1)
        self.assertAlmostEqual(result[0]['start_ts'], 9.92)
        self.assertEqual(result[1], source[1])
        self.assertEqual(source[0]['start_ts'], 2)

    def test_missing_voice_music_quiet_speech_and_continuous_words_are_preserved(self):
        source = [word('song or quiet speech', 2, 12)]
        for spans in [[], [(1, 12)], [(20, 22)], [(2.2, 12)]]:
            self.assertEqual(refine_whisper_onsets(source, spans), (source, 0))
        sentence = [{k:v for k,v in source[0].items() if k != '_timed_word'}]
        self.assertEqual(refine_whisper_onsets(sentence, [(10, 12)]), (sentence, 0))

    def test_word_end_and_full_text_survive_and_short_words_are_untouched(self):
        source = [word('one', 1, 1.2), word('two', 4, 6)]
        result, _ = refine_whisper_onsets(source, [(1, 1.3), (6.2, 7)])
        self.assertEqual(result[0], source[0])
        self.assertEqual([(c['text'], c['end_ts']) for c in source], [(c['text'], c['end_ts']) for c in result])
        self.assertAlmostEqual(result[1]['end_ts'] - result[1]['start_ts'], .2)
