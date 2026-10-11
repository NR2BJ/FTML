"""원시 시각 점수의 비교용 해독기. 운영 추출에는 연결하지 않는다."""

import numpy as np


def monotonic_timestamps(scores, duration, tick_seconds, *, minimum_word_ticks=0):
    """단어 순서를 지키는 최대 점수 경로. 길이 0 감소는 정확도의 증거가 아니다."""
    scores = np.asarray(scores, dtype=np.float64)
    if (scores.ndim != 2 or not scores.shape[0] or scores.shape[0] % 2
            or scores.size > 4_000_000 or not np.isfinite(scores).all()
            or not np.isfinite(duration) or duration <= 0
            or not np.isfinite(tick_seconds) or tick_seconds <= 0
            or minimum_word_ticks not in (0, 1)):
        raise ValueError("시각 점수 또는 비교 조건이 올바르지 않습니다")
    bins = min(scores.shape[1], int(np.floor(duration / tick_seconds + 1e-8)) + 1)
    if not bins:
        raise ValueError("시각 후보가 없습니다")
    scores = scores[:, :bins]
    rows = len(scores)
    parents = np.full((rows, bins), -1, dtype=np.int32)
    best = scores[0].copy()
    for row in range(1, rows):
        prefix = np.maximum.accumulate(best)
        improves = np.r_[np.isfinite(best[0]), best[1:] > prefix[:-1]]
        choices = np.maximum.accumulate(np.where(improves, np.arange(bins), -1))
        if row % 2 and minimum_word_ticks:
            prefix = np.r_[-np.inf, prefix[:-1]]
            choices = np.r_[-1, choices[:-1]]
        parents[row] = choices
        best = scores[row] + prefix
    if not np.isfinite(best).any():
        raise ValueError("입력 길이 안에서 단어 순서를 지키는 경로가 없습니다")
    index = int(best.argmax())
    path = [index]
    for row in range(rows - 1, 0, -1):
        index = int(parents[row, index])
        path.append(index)
    return np.asarray(path[::-1]).reshape(-1, 2) * tick_seconds
