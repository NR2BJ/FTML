import unittest
from itertools import product
import numpy as np
from ctc_alignment import align_ctc


class CTCAlignmentTests(unittest.TestCase):
    def test_matches_exhaustive_ctc_paths(self):
        rng = np.random.default_rng(52)
        for tokens in ([1], [1, 2], [1, 1], [2, 1, 2]):
            scores = rng.normal(size=(6, 3))
            best_score, best_path = -np.inf, None
            for path in product(range(3), repeat=6):
                collapsed = [token for i, token in enumerate(path)
                             if token != 0 and (i == 0 or token != path[i-1])]
                if collapsed != list(tokens):
                    continue
                score = sum(scores[i, token] for i, token in enumerate(path))
                if score > best_score:
                    best_score, best_path = score, path
            expected = []
            for frame, token in enumerate(best_path):
                if token and (frame == 0 or token != best_path[frame-1]):
                    expected.append([frame, frame+1])
                elif token:
                    expected[-1][1] = frame+1
            with self.subTest(tokens=tokens):
                result = align_ctc(scores, tokens, 0)
                self.assertEqual([(r['start_frame'], r['end_frame']) for r in result],
                                 [tuple(span) for span in expected])

    def test_blank_frames_remain_silent_and_repeated_letters_need_blank(self):
        labels = [0, 0, 1, 1, 0, 0, 2, 0, 2, 0, 0]
        scores = np.full((len(labels), 3), -20.)
        scores[np.arange(len(labels)), labels] = 0
        result = align_ctc(scores, [1, 2, 2], 0)
        self.assertEqual([(r['start_frame'], r['end_frame']) for r in result], [(2, 4), (6, 7), (8, 9)])

    def test_impossible_or_invalid_input_is_not_interpolated(self):
        for scores, tokens in [(np.zeros((2, 3)), [1, 1]), (np.zeros((2, 3)), []),
                               (np.zeros((2, 3)), [0]), (np.full((2, 3), np.nan), [1])]:
            with self.subTest(tokens=tokens), self.assertRaises(ValueError):
                align_ctc(scores, tokens, 0)


if __name__ == '__main__':
    unittest.main()
