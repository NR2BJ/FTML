import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import qwen_pipeline
from inference_runtime import StorageFullError
from qwen_pipeline import QwenPipeline, normalize_aligned_words, prepare_model


EXPORT_FIXTURE = """
import errno, json, os, sys, tempfile, time
from pathlib import Path
mode, output = sys.argv[1], Path(sys.argv[2])
scratch = Path(tempfile.mkdtemp())
(scratch / 'temporary-model.bin').write_bytes(b'fixture')
if mode == 'storage':
    raise OSError(errno.ENOSPC, 'No space left on device', str(scratch / 'private-path'))
if mode == 'quota':
    raise OSError(errno.EDQUOT, 'Disk quota exceeded', str(scratch / 'private-path'))
if mode == 'other':
    raise RuntimeError('unrelated conversion failure')
if mode == 'sleep':
    time.sleep(60)
output.mkdir()
(output / 'config.json').write_text(json.dumps({'temp': tempfile.gettempdir()}))
if mode != 'incomplete':
    (output / 'model.xml').write_text('<fixture/>')
    (output / 'model.bin').write_bytes(b'fixture')
"""


class QwenExportTests(unittest.TestCase):
    def setUp(self):
        self.home = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.root = self.home / "ftml-openvino"
        self.source = self.home / "source"
        self.source.mkdir()
        (self.source / "original.bin").write_bytes(b"original")
        self.enterContext(patch.dict(os.environ, {"HF_HOME": str(self.home), "QWEN_MODEL_REVISION": "fixture"}))
        self.download = Mock(return_value=str(self.source))
        self.enterContext(patch.dict(sys.modules, {"huggingface_hub": SimpleNamespace(snapshot_download=self.download)}))
        self.enterContext(patch.object(qwen_pipeline.shutil, "which", return_value="fixture-exporter"))
        self.mode, self.processes, self.commands = "ok", [], []
        real_popen = subprocess.Popen

        def spawn(command, **kwargs):
            self.commands.append((command, kwargs))
            process = real_popen([sys.executable, "-c", EXPORT_FIXTURE, self.mode, command[-1]], **kwargs)
            self.processes.append(process)
            return process

        self.enterContext(patch.object(qwen_pipeline.subprocess, "Popen", side_effect=spawn))
        self.enterContext(self.assertLogs("whisper", level="INFO"))

    def assert_workspace_removed(self):
        self.assertEqual(list(self.root.glob("export-*")), [])
        self.assertEqual((self.source / "original.bin").read_bytes(), b"original")
        for process in self.processes:
            self.assertIsNotNone(process.poll())

    def test_child_temporary_models_stay_in_workspace_and_cache_is_reused(self):
        environment_before = {key: os.environ.get(key) for key in ("TMPDIR", "TMP", "TEMP")}
        destination = prepare_model("Qwen/Qwen3-ASR-1.7B")
        command, kwargs = self.commands[0]
        scratch = Path(kwargs["env"]["TMPDIR"])
        self.assertEqual(scratch.parent.parent, self.root)
        self.assertEqual(scratch.parent, Path(command[-1]).parent)
        self.assertNotEqual(scratch, Path(command[-1]))
        self.assertEqual(kwargs["env"]["TMP"], str(scratch))
        self.assertEqual(kwargs["env"]["TEMP"], str(scratch))
        self.assertEqual(environment_before, {key: os.environ.get(key) for key in environment_before})
        import json
        self.assertEqual(json.loads((destination / "config.json").read_text())["temp"], str(scratch))
        self.assertTrue((destination / "ftml-ready.json").is_file())
        self.assertEqual(set(path.name for path in destination.iterdir()),
                         {"config.json", "model.xml", "model.bin", "ftml-ready.json"})
        self.assert_workspace_removed()
        self.assertEqual(prepare_model("Qwen/Qwen3-ASR-1.7B"), destination)
        self.download.assert_called_once()
        self.assertEqual(len(self.processes), 1)

    def test_storage_failures_are_classified_and_never_marked_ready(self):
        for mode in ("storage", "quota"):
            with self.subTest(mode=mode):
                self.mode = mode
                with self.assertRaises(StorageFullError) as caught:
                    prepare_model("Qwen/Qwen3-ASR-1.7B")
                self.assertNotIn("private-path", str(caught.exception))
                self.assertIn("저장 공간", str(caught.exception))
                self.assertEqual(list(self.root.iterdir()), [])
                self.assert_workspace_removed()

    def test_generic_failure_and_incomplete_output_do_not_become_cache(self):
        for mode in ("other", "incomplete"):
            with self.subTest(mode=mode):
                self.mode = mode
                with self.assertRaises(RuntimeError) as caught:
                    prepare_model("Qwen/Qwen3-ASR-1.7B")
                self.assertNotIsInstance(caught.exception, StorageFullError)
                self.assertEqual(list(self.root.iterdir()), [])
                self.assert_workspace_removed()

    def test_cancelled_export_is_reaped_and_temporary_files_are_removed(self):
        self.mode = "sleep"
        cancel = threading.Event()
        timer = threading.Timer(0.2, cancel.set)
        self.addCleanup(timer.cancel)
        timer.start()
        with self.assertRaises(InterruptedError):
            prepare_model("Qwen/Qwen3-ASR-1.7B", cancel)
        self.assertEqual(list(self.root.iterdir()), [])
        self.assert_workspace_removed()

    def test_export_timeout_reaps_process_and_removes_workspace(self):
        self.mode = "sleep"
        run_export = qwen_pipeline.run_export
        with patch.object(qwen_pipeline, "run_export", side_effect=lambda cmd, scratch, cancel: run_export(cmd, scratch, cancel, timeout=0.2)):
            with self.assertRaises(TimeoutError):
                prepare_model("Qwen/Qwen3-ASR-1.7B")
        self.assertEqual(list(self.root.iterdir()), [])
        self.assert_workspace_removed()


class QwenPipelineTests(unittest.TestCase):
    def make_pipeline(self):
        import numpy as np
        pipe = QwenPipeline.__new__(QwenPipeline)
        pipe.asr = Mock()
        pipe.asr.generate.return_value = SimpleNamespace(texts=["こんにちは。"], languages=["Japanese"])
        pipe.aligner = Mock()
        pipe.aligner.align.return_value = [[SimpleNamespace(text="こんにちは",start_time=2,end_time=3)]]
        return pipe, np.ones(5*16000,dtype=np.float32)

    def test_japanese_uses_official_cpu_aligner_and_language_name(self):
        pipe,audio = self.make_pipeline()
        result = pipe.generate(audio,SimpleNamespace(language="<|ja|>",context="名前"))
        self.assertEqual(pipe.asr.generate.call_args.kwargs["language"],"Japanese")
        self.assertEqual(pipe.asr.generate.call_args.kwargs["context"],"名前")
        self.assertEqual(pipe.aligner.align.call_args.kwargs["language"],"Japanese")
        self.assertEqual(result.words[0]["start_ts"],2)

    def test_auto_language_is_omitted_and_detected_language_reaches_aligner(self):
        for language in ["", "auto"]:
            with self.subTest(language=language):
                pipe, audio = self.make_pipeline()
                pipe.generate(audio, SimpleNamespace(language=language))
                self.assertNotIn("language", pipe.asr.generate.call_args.kwargs)
                self.assertEqual(pipe.aligner.align.call_args.kwargs["language"], "Japanese")

    def test_untimed_result_does_not_become_full_window_caption(self):
        pipe,audio = self.make_pipeline()
        pipe.aligner.align.return_value = [[]]
        with self.assertRaises(ValueError): pipe.generate(audio,SimpleNamespace(language="ja"))

    def test_symbols_only_do_not_reach_aligner(self):
        pipe,audio = self.make_pipeline()
        pipe.asr.generate.return_value.texts = [",,,,!!!!!"]
        self.assertEqual(pipe.generate(audio,SimpleNamespace(language="ja")).chunks,[])
        pipe.aligner.align.assert_not_called()

    def test_collapsed_timestamps_join_only_adjacent_words(self):
        words = [{"word":text,"start_ts":start,"end_ts":end} for text,start,end in
                 [("私",7.44,8.08),("もっと",8.48,8.48),("頑張り",8.96,8.96),("ます",11.76,11.92)]]
        result, count = normalize_aligned_words(words, "私もっと頑張ります。", 12)
        self.assertEqual(count, 2)
        self.assertEqual(result[1], {"word":"もっと頑張り","start_ts":8.48,"end_ts":8.96})
        self.assertLess(result[1]["end_ts"], result[2]["start_ts"])

    def test_isolated_collapsed_word_never_fills_long_silence(self):
        words = [{"word":"a","start_ts":1,"end_ts":2},{"word":"b","start_ts":5,"end_ts":5}]
        result,count = normalize_aligned_words(words,"ab",6)
        self.assertEqual(count,1)
        self.assertEqual(result[1],{"word":"b","start_ts":5,"end_ts":5.08})

    def test_collapsed_sentence_is_not_attached_to_next_sentence_when_separable(self):
        words = [{"word":"はい","start_ts":1,"end_ts":1},{"word":"次","start_ts":1.3,"end_ts":2}]
        result,count = normalize_aligned_words(words, "「はい。」次。", 3)
        self.assertEqual([w["word"] for w in result], ["「はい。」", "次。"])
        self.assertEqual(result[0]["end_ts"], 1.08)
        self.assertEqual(count, 1)

    def test_exact_boundary_uses_free_time_without_moving_valid_neighbor(self):
        words = [{"word":"はい","start_ts":1,"end_ts":1},{"word":"次","start_ts":1,"end_ts":2}]
        result,_ = normalize_aligned_words(words, "はい。次。", 3)
        self.assertAlmostEqual(result[0]["start_ts"], 0.92)
        self.assertEqual(result[0]["end_ts"], 1)
        self.assertEqual(result[1], {"word":"次。","start_ts":1,"end_ts":2})

    def test_no_room_at_sentence_boundary_does_not_add_alignment_failure(self):
        words = [{"word":"前","start_ts":0,"end_ts":1},{"word":"はい","start_ts":1,"end_ts":1},
                 {"word":"次","start_ts":1,"end_ts":2}]
        result,count = normalize_aligned_words(words, "前。はい。次。", 3)
        self.assertEqual("".join(w["word"] for w in result), "前。はい。次。")
        self.assertEqual(count, 1)
        self.assertTrue(all(w["end_ts"] > w["start_ts"] for w in result))

    def test_missing_text_and_invalid_timestamps_fail_explicitly(self):
        for words,text in [([{"word":"a","start_ts":1,"end_ts":2}], "ab"),
                           ([{"word":"a","start_ts":1,"end_ts":1}], "a"),
                           ([{"word":"a","start_ts":float('nan'),"end_ts":2}], "a")]:
            with self.assertRaises(ValueError): normalize_aligned_words(words,text,6)
