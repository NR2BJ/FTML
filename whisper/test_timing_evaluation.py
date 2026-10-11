from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch
import wave

from timing_evaluation import (compare_boundaries, evaluate, evaluate_case, evaluate_files, indicators,
                               markdown_report, read_json, reference_metrics, validate_cues, write_private, compare_exposure)
from timing_experiment import compare_snapshot, snapshot_from_trace, WaveSource


def cue(text, start, end, **extra):
    return dict(text=text, start_ts=start, end_ts=end, **extra)


def case():
    original = [cue("first", 1, 2), cue("reply", 4, 5)]
    return dict(schema_version=1, id="sample-qwen", work_id="work-a", split="development",
                duration=10, language="en", engine="qwen", baseline="base",
                variants={"base": {"cues": original}, "candidate": {"cues": deepcopy(original)}})


class EvaluationTests(unittest.TestCase):
    def test_merging_does_not_hide_earlier_display_of_later_text(self):
        result = compare_exposure([cue("first ", 1, 2), cue("second", 2.1, 3)], [cue("first second", 1, 3)])
        self.assertEqual(result["advanced_characters"], 6)
        self.assertAlmostEqual(result["maximum_advance_seconds"], 1.1)
        self.assertEqual(len(result["changes"]), 2)
        self.assertAlmostEqual(result["changes"][1]["start_delta"], -1.1)

    def test_exposure_follows_literal_order_even_for_repeated_or_overlapping_cues(self):
        original = [cue("yes", 1, 4), cue("yes", 2, 3)]
        result = compare_exposure(original, [cue("yes", 1, 4), cue("yes", 2.5, 3)])
        self.assertEqual(result["changes"], [dict(first=3, last=6, baseline_cue=1, cue=1, start_delta=.5, end_delta=0)])
        self.assertEqual(result["maximum_advance_seconds"], 0)
        self.assertEqual(compare_exposure([], [])["changes"], [])
        self.assertEqual(compare_exposure(original, [cue("no", 1, 3)])["status"], "text_changed")

    def test_no_reference_never_claims_quality_even_if_short_cues_disappear(self):
        sample = case()
        sample["variants"]["base"]["cues"][0]["end_ts"] = 1.1
        result = evaluate([sample])
        self.assertEqual(result["quality_verdict"], "not_automatically_decided")
        self.assertEqual(result["cases"][0]["variants"]["candidate"]["reference"]["status"], "no_reference")
        self.assertEqual(len(result["cases"][0]["variants"]["base"]["indicators"]["short_cue_indices"]), 1)

    def test_split_leakage_is_by_work_not_engine_or_clip(self):
        a, b = case(), case()
        b.update(id="different-clip", split="holdout", engine="whisper")
        with self.assertRaisesRegex(ValueError, "같은 작품"):
            evaluate([a, b])
        b["work_id"] = "another-work"
        self.assertEqual(len(evaluate([a, b])["strata"]), 2)

    def test_duplicate_id_rejected(self):
        with self.assertRaisesRegex(ValueError, "ID"):
            evaluate([case(), case()])

    def test_reference_requires_human_review(self):
        with self.assertRaisesRegex(ValueError, "검수"):
            reference_metrics([], {"verified_by": "model", "annotator": "same-aligner"}, 10)

    def test_mismatched_reference_is_not_partially_scored(self):
        reference = {"verified_by": "human", "annotator": "reviewer", "cues": [cue("another", 1, 2)]}
        self.assertEqual(reference_metrics([cue("something", 1, 2)], reference, 10)["status"], "reference_text_mismatch")

    def test_joined_later_speech_detected_without_inventing_word_times(self):
        reference = {"verified_by": "human", "annotator": "reviewer",
                     "cues": [cue("first", 1, 2), cue("reply", 4, 5)]}
        result = reference_metrics([cue("first reply", 1, 5)], reference, 10)
        self.assertEqual(result["early_starts"], [{"unit": 1, "seconds": 3}])
        self.assertEqual(result["late_ends"], [{"unit": 0, "seconds": 3}])

    def test_reference_tolerances_are_explicit(self):
        reference = {"verified_by": "human", "annotator": "reviewer",
                     "cues": [cue("first", 1, 2, onset_range=[.8, 1.1], offset_range=[1.9, 2.2])]}
        result = reference_metrics([cue("first", .9, 2.1)], reference, 10)
        self.assertEqual(result["start_error_seconds"]["maximum"], 0)
        self.assertEqual(result["end_error_seconds"]["maximum"], 0)
        reference["cues"][0]["onset_range"] = [.1, .2]
        with self.assertRaises(ValueError):
            reference_metrics([cue("first", 1, 2)], reference, 10)

    def test_display_gaps_are_not_hidden_by_outer_bounds(self):
        reference = {"verified_by": "human", "annotator": "reviewer", "cues": [cue("abc", 1, 5)]}
        result = reference_metrics([cue("a", 1, 2), cue("bc", 4, 5)], reference, 10)
        self.assertEqual(result["within_utterance_display_gaps_seconds"]["maximum"], 2)

    def test_overlapping_display_is_not_counted_as_a_gap(self):
        reference = {"verified_by": "human", "annotator": "reviewer", "cues": [cue("abc", 1, 6)]}
        result = reference_metrics([cue("a", 1, 5), cue("b", 2, 3), cue("c", 4, 6)], reference, 10)
        self.assertEqual(result["within_utterance_display_gaps_seconds"]["maximum"], 0)

    def test_same_repeated_text_uses_character_positions(self):
        result = compare_boundaries([cue("yes", 1, 2), cue("yes", 4, 5)],
                                    [cue("yes", 1, 2), cue("yes", 3, 5)])
        self.assertEqual(result["changes"], [{"cue": 1, "start_delta": -1, "end_delta": 0, "new_boundary": False}])

    def test_text_loss_is_not_timing_improvement(self):
        result = compare_boundaries([cue("a b", 1, 2)], [cue("a", 1, 2)])
        self.assertFalse(result["same_text"])
        self.assertEqual(result["status"], "text_changed")

    def test_whitespace_changes_are_reported_even_if_timing_can_be_compared(self):
        result = compare_boundaries([cue("now here", 1, 2)], [cue("nowhere", 1, 2)])
        self.assertTrue(result["same_text"])
        self.assertFalse(result["same_literal_text"])

    def test_loss_shared_by_all_variants_is_not_hidden(self):
        sample = case()
        sample["provenance"] = {"source_transcript_sha256": sha256(b"firstreplymissing").hexdigest()}
        result = evaluate_case(sample)
        self.assertTrue(result["variants"]["candidate"]["comparison"]["same_text"])
        self.assertFalse(result["variants"]["candidate"]["source_text_preserved"])

    def test_no_fake_boundary_delta_when_segmentation_changes(self):
        result = compare_boundaries([cue("abcd", 1, 5)], [cue("ab", 1, 2), cue("cd", 4, 5)])
        self.assertEqual(result["shared_starts"], 1)
        self.assertIsNone(result["changes"][1]["start_delta"])

    def test_overlaps_are_candidates_not_deleted(self):
        source = [cue("a", 1, 5), cue("b", 2, 3), cue("b", 3.1, 3.2)]
        result = indicators(source)
        self.assertEqual(result["overlap_indices"], [1, 2])
        self.assertEqual(result["adjacent_repeat_indices"], [2])
        self.assertEqual(len(source), 3)

    def test_invalid_timestamps_rejected_not_silently_removed(self):
        for source in ([cue("a", 1, float("nan"))], [cue("a", 2, 2)], [cue("a", 2, 3), cue("b", 1, 2)]):
            with self.assertRaises(ValueError):
                validate_cues(source, 10)

    def test_private_immutable_output(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder)/"result.json"
            write_private(target, evaluate([case()]))
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            self.assertEqual(len(read_json(target)["cases"]), 1)
            with self.assertRaises(FileExistsError):
                write_private(target, {})

    def test_total_input_limit_is_checked_before_loading(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/"large.json"
            with open(path, "wb") as stream:
                stream.truncate(17*1024*1024)
            with patch("timing_evaluation.read_json", side_effect=AssertionError("must not load")):
                with self.assertRaisesRegex(ValueError, "합계"):
                    evaluate_files([path, path])

    def test_report_contains_no_dialogue_or_false_ranking(self):
        sample = case()
        sample["variants"]["base"]["cues"][0]["text"] = "private dialogue"
        report = markdown_report(evaluate([sample]))
        self.assertNotIn("private dialogue", report)
        self.assertIn("오류 개수나 품질 순위가 아닙니다", report)


class ExperimentTests(unittest.TestCase):
    def test_display_comparison_cannot_change_original_text(self):
        source = self.snapshot()
        for name in ("display_review", "supported_review"):
            with self.assertRaisesRegex(ValueError, "원문"):
                compare_snapshot(source, **{name: lambda: [cue("rewritten", 1, 3)]})

    def test_display_comparison_is_separate_from_existing_variants(self):
        source = self.snapshot()
        expected = compare_snapshot(source)
        revised = compare_snapshot(source, display_review=lambda: deepcopy(source["cues"]),
                                   supported_review=lambda: deepcopy(source["cues"]))
        self.assertEqual(expected["variants"], {k: v for k, v in revised["variants"].items()
                                                if k not in ("source_boundaries", "supported_boundaries")})

    def snapshot(self, engine="qwen", language="en"):
        return dict(id="test", work_id="work", split="development", engine=engine, language=language,
                    duration=10, source_stage="before_speech_boundaries",
                    cues=[cue("hi", 1, 1.1, _segment=1), cue("bye", 4, 5, _segment=2)])

    def test_hold_removal_is_independent_and_snapshot_immutable(self):
        source = self.snapshot()
        saved = deepcopy(source)
        result = compare_snapshot(source)
        self.assertEqual(source, saved)
        self.assertEqual(result["variants"]["without_hold"]["cues"][0]["end_ts"], 1.1)
        self.assertGreater(result["variants"]["current"]["cues"][0]["end_ts"], 1.1)

    def test_missing_vad_cannot_masquerade_as_full_ablation(self):
        with self.assertRaisesRegex(ValueError, "관측 자료"):
            compare_snapshot(self.snapshot("whisper"))

    def test_japanese_requires_model_but_korean_and_english_do_not_use_it(self):
        source = self.snapshot(language="ja")
        source["cues"] = [cue("これはかなのながいはつわです。", 1, 5)]
        with self.assertRaisesRegex(ValueError, "음향 대조"):
            compare_snapshot(source)
        for language in ("ko", "en"):
            source["language"] = language
            def forbidden(*_):
                raise AssertionError("일본어 대조를 다른 언어에 적용하면 안 됩니다")
            compare_snapshot(source, forbidden)

    def test_review_cannot_rewrite_text(self):
        source = self.snapshot(language="ja")
        source["cues"] = [cue("これはかなのながいはつわです。", 1, 5)]
        with self.assertRaisesRegex(ValueError, "원문"):
            compare_snapshot(source, lambda _: ([cue("different", 1, 2)], {}))

    def test_disabled_acoustic_stage_is_not_accidentally_enabled(self):
        source = self.snapshot(language="ja")
        source["cues"] = [cue("これはかなのながいはつわです。", 1, 5)]
        source["acoustic_timing_enabled"] = False
        result = compare_snapshot(source)
        self.assertNotIn("without_acoustic", result["variants"])

    def test_expected_current_must_reproduce_production(self):
        source = self.snapshot()
        source["expected_current"] = compare_snapshot(source)["variants"]["current"]["cues"]
        self.assertIn("production_replay", compare_snapshot(source)["provenance"])
        source["expected_current"][0]["start_ts"] += .1
        with self.assertRaisesRegex(ValueError, "원래 완료 결과"):
            compare_snapshot(source)

    def test_removing_speech_reruns_downstream_review_on_its_own_input(self):
        source = self.snapshot("whisper", "ja")
        source["cues"] = [cue("これはかなのながいはつわです。", 1, 5)]
        source["speech_spans"] = [(3, 5)]
        inputs = []
        def refine(words, spans):
            result = deepcopy(words)
            result[0]["start_ts"] = 3
            return result, 1
        def review(words):
            inputs.append(deepcopy(words))
            return words, {}
        with patch("timing_experiment.refine_whisper_prefixes", side_effect=refine), \
                patch("timing_experiment.refine_whisper_onsets", side_effect=lambda w, _: (w, 0)):
            result = compare_snapshot(source, review)
        self.assertEqual([words[0]["start_ts"] for words in inputs], [3, 1])
        self.assertEqual(result["variants"]["without_speech"]["cues"][0]["start_ts"], 1)

    def test_trace_missing_or_duplicate_context_is_rejected(self):
        records = [dict(stage="before_speech_boundaries", cues=[]), dict(stage="final", cues=[])]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/"trace.jsonl"
            def write():
                path.write_text("\n".join(json.dumps(r) for r in records))
            write()
            with self.assertRaisesRegex(ValueError, "모두"):
                snapshot_from_trace(path)
            records.append(dict(stage="timing_experiment_context", speech_spans=[],
                                speech_boundaries_enabled=True, acoustic_timing_enabled=True))
            write()
            self.assertTrue(snapshot_from_trace(path)["speech_boundaries_enabled"])
            records.append(records[-1])
            write()
            with self.assertRaisesRegex(ValueError, "섞여"):
                snapshot_from_trace(path)

    def test_models_never_import_on_mac(self):
        from timing_experiment import main
        with patch.object(sys, "platform", "darwin"):
            with self.assertRaises(SystemExit):
                main()

    def test_wave_format_and_duration_are_checked(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/"audio.wav"
            with wave.open(str(path), "wb") as output:
                output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                output.writeframes(b"\0\0"*16000)
            with self.assertRaises(ValueError):
                WaveSource(path, 2)
            reader = WaveSource(path, 1)
            try:
                self.assertEqual(len(reader.read(0, 16000)), 16000)
                with self.assertRaises(ValueError):
                    reader.read(0, 16001)
                self.assertEqual(reader.trim([cue("a", 0, 1)]), [])
            finally:
                reader.stream.close()


if __name__ == "__main__":
    unittest.main()
