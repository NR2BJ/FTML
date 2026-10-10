"""HTTP/inference-flow tests with a fake model; no GPU/model download or API calls."""

import io
import errno
import json
import threading
import unittest
import wave
import sys
from types import SimpleNamespace
from unittest.mock import patch
from inference_runtime import STORAGE_FULL_MESSAGE, StorageFullError
from qwen_alignment import QwenAlignmentError

try:
    import numpy as np
    from fastapi.testclient import TestClient
    import server
except ImportError:
    server = None


@unittest.skipIf(server is None, "Install Whisper web/audio dependencies to run service tests")
class ServerTests(unittest.TestCase):
    def test_alignment_retry_is_local_and_keeps_absolute_timing(self):
        calls = []
        model = self.model([])
        def generate(audio, config):
            calls.append(len(audio)/16000)
            if len(calls) == 1:
                raise QwenAlignmentError("all_collapsed")
            return SimpleNamespace(words=[{"word": "a" if len(calls) == 2 else "b", "start_ts": 2, "end_ts": 3}],
                                   chunks=[{"text": "a" if len(calls) == 2 else "b", "start_ts": 0, "end_ts": len(audio)/16000}])
        model.generate = generate
        with patch.object(server, "pipeline", model), patch.object(server, "model_id_str", "Qwen/Qwen3-ASR-1.7B"):
            cues = server._generate_timed_chunks(np.ones(30*16000), SimpleNamespace(), 1400, 1460)
        self.assertEqual(calls, [30, 16, 16])
        self.assertEqual([(c["start_ts"], c["end_ts"]) for c in cues], [(1402, 1403), (1416, 1417)])
        self.assertEqual(model.recovered_alignment_windows, 1)

    def test_successful_alignment_has_no_extra_inference(self):
        from unittest.mock import Mock
        model = self.model([])
        model.generate = Mock(return_value=SimpleNamespace(chunks=[{"text":"a", "start_ts":1, "end_ts":2}]))
        with patch.object(server, "pipeline", model):
            server._generate_timed_chunks(np.ones(30*16000), SimpleNamespace(), 0, 30)
        model.generate.assert_called_once()

    def test_late_window_recovery_preserves_previous_cues_and_continues(self):
        calls = []
        model = self.model([])
        model.chunk_seconds = 30
        def generate(audio, config):
            calls.append(len(audio)/16000)
            if len(calls) == 2:
                raise QwenAlignmentError("all_collapsed")
            text = {1:"a", 3:"b", 4:"c", 5:"d"}[len(calls)]
            return SimpleNamespace(words=[{"word":text, "start_ts":2, "end_ts":3}],
                                   chunks=[{"text":text, "start_ts":0, "end_ts":len(audio)/16000}])
        model.generate = generate
        with patch.object(server, "pipeline", model), patch.object(server, "model_id_str", "Qwen/Qwen3-ASR-1.7B"), patch.object(server, "CHUNK_OVERLAP_S", 5), patch.object(server, "GAP_MAX_RETRY_S", 0):
            cues, _, _, _ = server.run_inference(np.ones(60*16000), model="Qwen/Qwen3-ASR-1.7B")
        self.assertEqual(calls, [30, 30, 16, 16, 10])
        self.assertEqual([(c["text"], c["start_ts"], c["end_ts"]) for c in cues],
                         [("a", 2, 3), ("b", 27, 28), ("c", 41, 42), ("d", 52, 53)])

    def test_alignment_retry_limit_keeps_failure_explicit(self):
        from unittest.mock import Mock
        model = self.model([])
        model.generate = Mock(side_effect=QwenAlignmentError("out_of_range"))
        with patch.object(server, "pipeline", model), patch.object(server, "model_id_str", "Qwen/Qwen3-ASR-1.7B"):
            with self.assertRaises(QwenAlignmentError) as caught:
                server._generate_timed_chunks(np.ones(30*16000), SimpleNamespace(), 1400, 1460)
        self.assertEqual(model.generate.call_count, 3)
        self.assertEqual(caught.exception.window, (1400, 1409))
        self.assertEqual(caught.exception.reason, "out_of_range")

    def test_alignment_retry_never_turns_empty_results_into_success(self):
        from unittest.mock import Mock
        model = self.model([])
        model.generate = Mock(side_effect=[QwenAlignmentError("all_collapsed"), SimpleNamespace(chunks=[]), SimpleNamespace(chunks=[])])
        with patch.object(server, "pipeline", model), patch.object(server, "model_id_str", "Qwen/Qwen3-ASR-1.7B"):
            with self.assertRaises(QwenAlignmentError) as caught:
                server._generate_timed_chunks(np.ones(30*16000), SimpleNamespace(), 1400, 1460)
        self.assertEqual(caught.exception.reason, "empty_retry")

    def test_alignment_retry_honors_cancel_before_second_inference(self):
        cancel, calls = threading.Event(), []
        model = self.model([])
        def generate(*args):
            calls.append(True)
            cancel.set()
            raise QwenAlignmentError("empty")
        model.generate = generate
        with patch.object(server, "pipeline", model), patch.object(server, "model_id_str", "Qwen/Qwen3-ASR-1.7B"):
            with self.assertRaises(InterruptedError):
                server._generate_timed_chunks(np.ones(30*16000), SimpleNamespace(), 0, 30, cancel)
        self.assertEqual(len(calls), 1)

    def test_unrelated_inference_errors_are_not_retried(self):
        from unittest.mock import Mock
        model = self.model([])
        model.generate = Mock(side_effect=RuntimeError("GPU failure"))
        with patch.object(server, "pipeline", model), patch.object(server, "model_id_str", "Qwen/Qwen3-ASR-1.7B"):
            with self.assertRaises(RuntimeError):
                server._generate_timed_chunks(np.ones(30*16000), SimpleNamespace(), 0, 30)
        model.generate.assert_called_once()

    def test_http_alignment_failure_exposes_window_and_reason(self):
        from unittest.mock import Mock
        model = self.model([])
        model.generate = Mock(side_effect=QwenAlignmentError("all_collapsed"))
        with patch.object(server, "pipeline", model), patch.object(server, "model_id_str", "Qwen/Qwen3-ASR-1.7B"):
            response = self.client.post("/v1/audio/transcriptions", files={"file": ("audio.wav", self.wav(2))},
                                        data={"model":"Qwen/Qwen3-ASR-1.7B"})
        self.assertEqual(response.status_code, 422)
        self.assertIn("00:00.000~00:02.000", response.json()["detail"])
        self.assertIn("모든 단어", response.json()["detail"])

    def test_recovery_diagnostics_do_not_leak_into_next_job(self):
        from unittest.mock import Mock
        model = self.model([])
        success = SimpleNamespace(chunks=[{"text":"a", "start_ts":2, "end_ts":3}])
        model.generate = Mock(side_effect=[QwenAlignmentError("empty"), success, success, success])
        with patch.object(server, "pipeline", model), patch.object(server, "model_id_str", "Qwen/Qwen3-ASR-1.7B"):
            first = self.client.post("/v1/audio/transcriptions", files={"file": ("audio.wav", self.wav(30))},
                                     data={"model":"Qwen/Qwen3-ASR-1.7B", "response_format":"ftml_json"})
            second = self.client.post("/v1/audio/transcriptions", files={"file": ("audio.wav", self.wav(30))},
                                      data={"model":"Qwen/Qwen3-ASR-1.7B", "response_format":"ftml_json"})
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json()["diagnostics"]["timing_recovered_windows"], 1)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()["diagnostics"]["timing_recovered_windows"], 0)

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
        model_patch = patch.object(server, "model_id_str", server.DEFAULT_MODEL_ID)
        model_patch.start()
        self.addCleanup(model_patch.stop)
        download_patch = patch("huggingface_hub.snapshot_download", side_effect=AssertionError("시험 중 모델 다운로드 금지"))
        download_patch.start()
        self.addCleanup(download_patch.stop)
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

    def test_storage_exhaustion_is_actionable_without_exposing_internal_paths(self):
        failures = [StorageFullError(), OSError(errno.ENOSPC, "No space left", "/private/model"),
                    OSError(errno.EDQUOT, "Disk quota exceeded", "/private/model")]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__), patch.object(server, "_run_upload", side_effect=failure), self.assertLogs("whisper", level="ERROR"):
                response = self.client.post("/v1/audio/transcriptions", files={"file": ("audio.wav", self.wav(1))})
                self.assertEqual(response.status_code, 507)
                self.assertEqual(response.json()["detail"], STORAGE_FULL_MESSAGE)
                self.assertNotIn("/private", response.text)

    def test_model_loading_reports_storage_exhaustion(self):
        with patch.object(server, "pipeline", None), patch.object(server, "loading_model", False), patch.object(server, "load_model_by_id", side_effect=StorageFullError()), self.assertLogs("whisper", level="ERROR"):
            response = self.client.post("/v1/model/load", json={"model_id": "Qwen/Qwen3-ASR-1.7B"})
        self.assertEqual(response.status_code, 507)
        self.assertEqual(response.json()["detail"], STORAGE_FULL_MESSAGE)

    def test_unrelated_inference_error_is_not_reported_as_storage_exhaustion(self):
        with patch.object(server, "_run_upload", side_effect=RuntimeError("private failure details")), self.assertLogs("whisper", level="ERROR"):
            response = self.client.post("/v1/audio/transcriptions", files={"file": ("audio.wav", self.wav(1))})
        self.assertEqual(response.status_code, 500)
        self.assertNotIn("private failure details", response.text)

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
        with patch.object(server, "pipeline", model), patch.object(server, "GAP_MAX_RETRY_S", 300):
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

    def test_lyrics_result_keeps_original_and_reports_rejection_without_losing_extraction(self):
        model = self.model([SimpleNamespace(text="original", start_ts=0.1, end_ts=0.5)])
        model.align_reference = lambda *_: SimpleNamespace(
            chunks=[{"text":"corrected", "start_ts":0, "end_ts":1}],
            words=[{"word":"corrected", "start_ts":0.2, "end_ts":0.7}])
        data = {"model":"Qwen/Qwen3-ASR-1.7B","language":"ja","response_format":"ftml_json",
                "reference_lyrics":json.dumps({"start":0,"end":1,"text":"corrected"})}
        with patch.object(server,"pipeline",model), patch.object(server,"model_id_str",data["model"]):
            response = self.client.post("/v1/audio/transcriptions",data=data,files={"file":("a.wav",self.wav(2))})
            self.assertEqual(response.status_code,200,response.text)
            self.assertIn("original",response.json()["raw_vtt"])
            self.assertIn("corrected",response.json()["vtt"])
            data["reference_lyrics"] = json.dumps({"start":0.3,"end":1,"text":"corrected"})
            response = self.client.post("/v1/audio/transcriptions",data=data,files={"file":("a.wav",self.wav(2))})
            self.assertEqual(response.status_code,200,response.text)
            self.assertIn("original",response.json()["vtt"])
            self.assertEqual(response.json()["raw_vtt"], "")
            self.assertIn("lyrics_error",response.json()["diagnostics"])

    def test_invalid_lyrics_never_reaches_model(self):
        with patch.object(server,"_run_upload") as run:
            for lyrics in [[],{"start":0,"end":181,"text":"song"},{"start":0,"end":1,"text":""}]:
                response = self.client.post("/v1/audio/transcriptions",data={"reference_lyrics":json.dumps(lyrics)},files={"file":("a.wav",self.wav(2))})
                self.assertEqual(response.status_code,400,response.text)
            run.assert_not_called()

    def test_only_fixed_whisper_and_qwen_models_are_accepted(self):
        with patch.object(server, "_run_upload") as run, patch.object(server, "load_model_by_id") as load:
            for mid in ["OpenVINO/whisper-tiny-int8-ov", "OpenVINO/whisper-large-v3-fp16-ov", "whisper-1"]:
                response = self.client.post("/v1/audio/transcriptions", data={"model":mid}, files={"file":("a.wav",self.wav(1))})
                self.assertEqual(response.status_code, 400)
                response = self.client.post("/v1/model/load", json={"model_id":mid})
                self.assertEqual(response.status_code, 400)
            run.assert_not_called()
            load.assert_not_called()

    def test_startup_does_not_download_or_load_models(self):
        # 이 시험은 gate를 닫으므로 별도 gate를 사용한다.
        with patch.object(server, "gate", server.ModelGate(0)), patch.object(server, "load_model_by_id") as load:
            with TestClient(server.app) as client:
                self.assertEqual(client.get("/health").status_code, 200)
            load.assert_not_called()


if __name__ == "__main__":
    unittest.main()
