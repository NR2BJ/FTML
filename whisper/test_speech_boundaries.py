import unittest
from speech_observer import refine_whisper_onsets

def word(text, start, end):
    return dict(text=text, start_ts=start, end_ts=end, _segment=(0, 1), _timed_word=True)

class SpeechBoundaryTests(unittest.TestCase):
    def test_long_leading_silence_is_not_part_of_first_word(self):
        source = [word('first', 2, 11), word('next', 11, 12)]
        result, count = refine_whisper_onsets(source, [(10, 12)])
        self.assertEqual(count, 1)
        self.assertAlmostEqual(result[0]['start_ts'], 9.65)
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
