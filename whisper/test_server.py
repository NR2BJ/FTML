"""HTTP/inference-flow tests with a fake model; no GPU/model download or API calls."""

import io
import threading
import unittest
import wave
import sys
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
    def test_word_pipeline_failure_keeps_segment_fallback_explicit(self):
        attempts = []
        def construct(*args, **kwargs):
            attempts.append(kwargs)
            if kwargs.get("word_timestamps"):
                raise RuntimeError("unsupported timing fixture")
            return self.model([])
        modules = {"openvino_genai": SimpleNamespace(WhisperGenerationConfig=lambda:SimpleNamespace(word_timestamps=False),WhisperPipeline=construct),
                   "huggingface_hub": SimpleNamespace(snapshot_download=lambda *args,**kwargs:"fixture-model")}
        with patch.dict(sys.modules, modules), patch.object(server,"WORD_TIMESTAMPS",True), patch.object(server,"pipeline",None), patch.object(server,"model_id_str",None), patch.object(server,"word_timestamps_active",False):
            with self.assertLogs("whisper",level="WARNING"):
                server.load_model_by_id("fixture")
            self.assertFalse(server.word_timestamps_active)
            self.assertIsNotNone(server.pipeline)
        self.assertEqual(attempts,[{"word_timestamps":True},{}])

    def test_digital_silence_does_not_reach_whisper(self):
        model = self.model([])
        model.generate = lambda *_: self.fail("디지털 무음을 인식함")
        with patch.object(server, "pipeline", model):
            chunks, _, _, _ = server.run_inference(np.zeros(40*16000, dtype=np.float32))
        self.assertEqual(chunks, [])

    def test_segment_edges_trim_only_digital_silence(self):
        audio = np.zeros(5*16000, dtype=np.float32)
        audio[2*16000:3*16000] = 0.000001  # 작은 목소리를 크기로 제거하지 않는다.
        model = self.model([SimpleNamespace(text="quiet", start_ts=0, end_ts=5)])
        with patch.object(server, "pipeline", model), patch.object(server, "GAP_THRESHOLD_S", 0):
            chunks, _, _, _ = server.run_inference(audio)
        self.assertAlmostEqual(chunks[0]["start_ts"], 1.98)
        self.assertAlmostEqual(chunks[0]["end_ts"], 3.02)

    def test_word_timing_applies_absolute_chunk_offset(self):
        calls = []
        def generate(audio, config):
            calls.append(True)
            self.assertTrue(config.word_timestamps)
            return SimpleNamespace(chunks=[SimpleNamespace(text="hello", start_ts=0, end_ts=4)], words=[SimpleNamespace(word="hello", start_ts=2, end_ts=3)])
        model = self.model([])
        model.generate = generate
        with patch.object(server, "pipeline", model), patch.object(server, "word_timestamps_active", True), patch.object(server, "CHUNK_DURATION_S", 30), patch.object(server, "CHUNK_OVERLAP_S", 5), patch.object(server, "GAP_THRESHOLD_S", 0):
            chunks, _, _, _ = server.run_inference(np.ones(40*16000, dtype=np.float32))
        self.assertEqual([c["start_ts"] for c in chunks], [2, 27])

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
