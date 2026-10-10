import copy
import threading
import unittest

from qwen_context_alignment import repair_stranded_tails


def word(text, start, end):
    return {"word": text, "start_ts": start, "end_ts": end}


class QwenContextAlignmentTests(unittest.TestCase):
    def setUp(self):
        self.original = [word("前です。", 0, 1), word("開発", 2, 2.4), word("第一", 2.4, 2.8),
                         word("係", 2.8, 3.2), word("山", 3.5, 3.5), word("田", 3.7, 3.7),
                         word("太郎", 6.2, 6.36), word("です。", 6.36, 6.36),
                         word("次の人", 6.36, 7), word("です。", 7, 7.2)]
        self.fixed = [word("開発", 2, 2.4), word("第一", 2.4, 2.8), word("係", 2.8, 3.2),
                      word("山田", 3.3, 3.8), word("太郎", 3.8, 4.2), word("です。", 4.2, 4.5)]
        self.text = "".join(w["word"] for w in self.original)
        self.calls = []

    def align(self, source, start, end, tokens):
        self.calls.append((source, start, end, tokens))
        words = self.original[:1]+self.fixed+self.original[8:] if source == self.text else self.fixed
        return [dict(w, start_ts=w["start_ts"]-start, end_ts=w["end_ts"]-start) for w in words]

    def repair(self, align=None, words=None, **kwargs):
        original = words if words is not None else self.original
        return repair_stranded_tails(original, "".join(w["word"] for w in original), 8, align or self.align, **kwargs)

    def test_two_contexts_agree_and_preserve_text_neighbors_and_input(self):
        before = copy.deepcopy(self.original)
        result, attempts, adopted = self.repair()
        self.assertEqual((attempts, adopted), (2, 1))
        self.assertEqual(result, self.original[:1]+self.fixed[:3]+[word("山田太郎です。", 3.3, 4.5)]+self.original[8:])
        self.assertEqual(self.original, before)
        self.assertEqual("".join(w["word"] for w in result), self.text)
        self.assertEqual(self.calls[0][0], "開発第一係山田太郎です。")
        self.assertEqual(self.calls[0][3], ["開発", "第一", "係", "山田", "太郎", "です"])
        self.assertEqual(self.calls[1][0], self.calls[0][0])
        self.assertAlmostEqual(self.calls[1][1], 1.2)
        self.assertEqual(self.calls[1][2], self.calls[0][2])
        self.assertLess(result[-3]["end_ts"], result[-2]["start_ts"]-1)

    def test_existing_success_or_normal_pause_never_reaches_fallback(self):
        success = self.original[:1]+self.fixed+self.original[8:]
        cases = [success, self.original[:8]]
        for index, values in [(6, {"start_ts": 5.5}), (7, {"end_ts": 6.4}),
                              (8, {"start_ts": 6.8}), (6, {"start_ts": 4.2, "end_ts": 4.36}),
                              (5, {"end_ts": 4.0})]:
            changed = copy.deepcopy(self.original)
            changed[index].update(values)
            if index == 7:
                changed[8]["start_ts"] = 6.4
            cases.append(changed)
        for words in cases:
            with self.subTest(words=words):
                result, attempts, adopted = self.repair(words=words)
                self.assertEqual((result, attempts, adopted), (words, 0, 0))
        self.assertEqual(self.calls, [])

    def test_invalid_or_unstable_first_pass_never_reaches_context_check(self):
        for fault in ("zero", "changed", "early_prefix", "still_late", "empty", "outside"):
            def align(*args):
                words = self.align(*args)
                if fault == "zero":
                    for w in words[3:]:
                        w["start_ts"] = w["end_ts"] = words[3]["start_ts"]
                elif fault == "changed":
                    words[3]["word"] = "別人"
                elif fault == "early_prefix":
                    words[0]["start_ts"] -= .8
                    words[0]["end_ts"] -= .8
                elif fault == "still_late":
                    words[-1]["end_ts"] = 6.3-args[1]
                elif fault == "empty":
                    words = []
                elif fault == "outside":
                    words[-1]["end_ts"] = 40
                return words
            with self.subTest(fault=fault):
                self.calls.clear()
                result, attempts, adopted = self.repair(align)
                self.assertEqual((result, attempts, adopted), (self.original, 1, 0))
                self.assertEqual(len(self.calls), 1)

    def test_context_disagreement_or_neighbor_drift_keeps_original(self):
        for fault in ("disagree", "prefix", "end", "text", "empty"):
            self.calls.clear()
            def align(source, *args):
                words = self.align(source, *args)
                if len(self.calls) == 2:
                    if fault == "disagree":
                        words[-1]["end_ts"] += .4
                    elif fault == "prefix":
                        words[0]["start_ts"] -= .7
                    elif fault == "end":
                        words[-1]["end_ts"] += .7
                    elif fault == "text":
                        words[3]["word"] = "別人"
                    elif fault == "empty":
                        return []
                return words
            with self.subTest(fault=fault):
                self.assertEqual(self.repair(align), (self.original, 2, 0))

    def test_uncertain_internal_word_times_become_one_phrase_not_guessed_words(self):
        def align(*args):
            words = self.align(*args)
            if len(self.calls) == 2:
                words[3]["start_ts"] += .28
                words[4]["end_ts"] = words[4]["start_ts"]
            return words
        result, attempts, adopted = self.repair(align)
        self.assertEqual((attempts, adopted), (2, 1))
        self.assertEqual(result[-3], word("山田太郎です。", 3.3, 4.5))

    def test_budget_requires_both_checks(self):
        for budget in (0, 1):
            self.assertEqual(self.repair(max_attempts=budget), (self.original, 0, 0))
        self.assertEqual(self.calls, [])
        self.assertEqual(self.repair(max_attempts=2)[1:], (2, 1))

    def test_embedded_sentence_boundary_is_not_merged_into_one_phrase(self):
        words = copy.deepcopy(self.original)
        words[6]["word"] = "太。郎"
        self.assertEqual(self.repair(words=words), (words, 0, 0))
        self.assertEqual(self.calls, [])

    def test_insufficient_extra_audio_context_keeps_original(self):
        words = copy.deepcopy(self.original)
        words[0]["end_ts"] = 1.8
        self.assertEqual(self.repair(words=words), (words, 0, 0))
        self.assertEqual(self.calls, [])

    def test_optional_failure_keeps_original_but_cancellation_propagates(self):
        def failed(*args):
            raise RuntimeError("probe failed")
        self.assertEqual(self.repair(failed), (self.original, 1, 0))
        for cancelled_call in (1, 2):
            cancel = threading.Event()
            self.calls.clear()
            def align(*args):
                result = self.align(*args)
                if len(self.calls) == cancelled_call:
                    cancel.set()
                return result
            with self.assertRaises(InterruptedError):
                self.repair(align, cancel=cancel)


if __name__ == "__main__":
    unittest.main()
