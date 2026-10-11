import itertools
import unittest

import numpy as np

from alignment_scores import monotonic_timestamps


class ScoreTests(unittest.TestCase):
    def test_matches_exhaustive_global_optimum_not_local_argmax(self):
        rng = np.random.default_rng(42)
        for minimum in (0, 1):
            for _ in range(30):
                scores = rng.normal(size=(4, 5))
                actual = np.rint(monotonic_timestamps(scores, 4, 1, minimum_word_ticks=minimum)).astype(int).ravel()
                candidates = [path for path in itertools.combinations_with_replacement(range(5), 4)
                              if path[1]-path[0] >= minimum and path[3]-path[2] >= minimum]
                best = max(sum(scores[i, value] for i, value in enumerate(path)) for path in candidates)
                self.assertAlmostEqual(sum(scores[i, value] for i, value in enumerate(actual)), best)

    def test_does_not_force_nonzero_words_unless_comparing_that_policy(self):
        scores = np.array([[0, 10, 0], [0, 10, 0]])
        self.assertEqual(monotonic_timestamps(scores, 2, 1).tolist(), [[1, 1]])
        result = monotonic_timestamps(scores, 2, 1, minimum_word_ticks=1)
        self.assertGreater(result[0, 1], result[0, 0])

    def test_bounds_and_invalid_inputs(self):
        scores = np.array([[0, 3, 100], [0, 3, 100]])
        self.assertEqual(monotonic_timestamps(scores, .08, .08).tolist(), [[.08, .08]])
        for data in ([], [[1, 2]], [[float('nan')], [0]], [[], []]):
            with self.subTest(data=data), self.assertRaises(ValueError):
                monotonic_timestamps(data, 1, .08)
        with self.assertRaises(ValueError):
            monotonic_timestamps(np.ones((4, 2)), .08, .08, minimum_word_ticks=1)


if __name__ == '__main__':
    unittest.main()
