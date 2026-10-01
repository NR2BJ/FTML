"""HTTP/inference-flow tests with a fake model; no GPU/model download or API calls."""

import io
import threading
import unittest
import wave
from types import SimpleNamespace
from unittest.mock import patch

try:
    import numpy as np
    from fastapi.testclient import TestClient
    import server
except ImportError:
    server = None


@unittest.skipIf(server is None, "Install Whisper web/audio dependencies to run service tests")
class ServerTests(unittest.TestCase):
    def setUp(self):
        server.gate.idle_timeout = 0
        self.client = TestClient(server.app)
        self.addCleanup(self.client.close)

    def model(self, chunks):
        return SimpleNamespace(
            get_generation_config=lambda: SimpleNamespace(),
            generate=lambda audio, config: SimpleNamespace(chunks=chunks),
        )

    def wav(self, seconds):
        result = io.BytesIO()
        with wave.open(result, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(np.full(seconds*16000, 1000, dtype=np.int16).tobytes())
        return result.getvalue()

    def test_empty_result_is_not_a_100_hour_subtitle(self):
        with patch.object(server, "pipeline", self.model([])), patch.object(server, "GAP_THRESHOLD_S", 0):
            response = self.client.post("/v1/audio/transcriptions", files={"file": ("audio.wav", self.wav(2), "audio/wav")})
        self.assertEqual(response.status_code, 422)
        self.assertNotIn("99:59:59", response.text)

    def test_verbose_json_uses_real_audio_duration(self):
        cue = SimpleNamespace(text="No", start_ts=0.1, end_ts=0.5)
        with patch.object(server, "pipeline", self.model([cue])), patch.object(server, "GAP_THRESHOLD_S", 0):
            response = self.client.post("/v1/audio/transcriptions", data={"response_format": "verbose_json"}, files={"file": ("audio.wav", self.wav(2), "audio/wav")})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["duration"], 2)
        self.assertEqual(response.json()["segments"][0]["text"], "No")

    def test_short_empty_first_pass_is_retried(self):
        calls = []
        def generate(audio, config):
            calls.append(len(audio))
            return SimpleNamespace(chunks=[] if len(calls) == 1 else [SimpleNamespace(text="hello", start_ts=1, end_ts=2)])
        model = self.model([])
        model.generate = generate
        with patch.object(server, "pipeline", model):
            chunks, _, _, duration = server.run_inference(np.ones(20*16000, dtype=np.float32))
        self.assertEqual(duration, 20)
        self.assertEqual(chunks[0]["text"], "hello")
        self.assertEqual(len(calls), 2)

    def test_disconnect_cancels_between_gpu_calls(self):
        cancel = threading.Event()
        calls = []
        def generate(audio, config):
            calls.append(True)
            cancel.set()
            return SimpleNamespace(chunks=[])
        model = self.model([])
        model.generate = generate
        with patch.object(server, "pipeline", model), patch.object(server, "CHUNK_DURATION_S", 2), patch.object(server, "CHUNK_OVERLAP_S", 1):
            with self.assertRaises(InterruptedError):
                server.run_inference(np.ones(5*16000, dtype=np.float32), cancel=cancel)
        self.assertEqual(len(calls), 1)

    def test_long_gap_reads_are_bounded(self):
        sizes = []
        def audio(start, end):
            sizes.append(end-start)
            return np.ones(end-start, dtype=np.float32)
        with patch.object(server, "pipeline", self.model([])), patch.object(server, "GAP_MAX_RETRY_S", 60):
            server._recover_gaps(audio, [], SimpleNamespace(), 3600)
        self.assertEqual(len(sizes), 2)
        self.assertLessEqual(max(sizes), 34*16000)


if __name__ == "__main__":
    unittest.main()
