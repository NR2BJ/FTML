import unittest
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np
from speech_observer import SpeechObserver


class SpeechObserverTests(unittest.TestCase):
    def test_observation_never_masks_input_and_deduplicates_window_overlap(self):
        module = SimpleNamespace(load_silero_vad=lambda **_:object(),
                                 get_speech_timestamps=lambda *_args,**_kwargs:[{"start":1,"end":3}])
        audio = np.ones(5*16000,dtype=np.float32)
        chunks = [{"text":"a","start_ts":2,"end_ts":3},{"text":"b","start_ts":6,"end_ts":7}]
        with patch.dict("sys.modules",{"silero_vad":module}):
            observer = SpeechObserver()
            observer.observe(audio,chunks,0)
            observer.observe(audio,chunks,1)
        self.assertTrue(np.all(audio == 1))
        self.assertEqual(observer.finish(chunks),{"speech_seconds":3,"cues_checked":2,"cues_outside_speech":1})
