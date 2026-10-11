"""비교용 CTC 시간 정렬. 인식 문구는 입력으로 고정하며 새 문구를 생성하지 않는다."""

import numpy as np


def align_ctc(log_probs, tokens, blank_id):
    """표준 CTC 상태 경로를 구한다. 점수는 실제 정확도나 확률 보증이 아니다."""
    log_probs = np.asarray(log_probs, dtype=np.float64)
    tokens = np.asarray(tokens, dtype=np.int64)
    if (log_probs.ndim != 2 or tokens.ndim != 1 or not tokens.size
            or not np.isfinite(log_probs).all() or not 0 <= blank_id < log_probs.shape[1]
            or np.any(tokens < 0) or np.any(tokens >= log_probs.shape[1]) or np.any(tokens == blank_id)):
        raise ValueError("CTC 입력이 올바르지 않습니다")
    frames, _ = log_probs.shape
    labels = np.full(tokens.size * 2 + 1, blank_id, dtype=np.int64)
    labels[1::2] = tokens
    states = len(labels)
    if frames * states > 8_000_000:
        raise ValueError("CTC 검사 입력이 너무 큽니다")
    skip = np.r_[False, False, (labels[2:] != blank_id) & (labels[2:] != labels[:-2])]
    previous = np.full(states, -np.inf)
    previous[0] = 0
    parents = np.zeros((frames, states), dtype=np.uint8)
    for frame in range(frames):
        options = np.stack((previous, np.r_[-np.inf, previous[:-1]],
                            np.where(skip, np.r_[-np.inf, -np.inf, previous[:-2]], -np.inf)))
        choices = options.argmax(axis=0)
        parents[frame] = choices
        previous = options[choices, np.arange(states)] + log_probs[frame, labels]
    state = states - 1 if previous[-1] >= previous[-2] else states - 2
    if not np.isfinite(previous[state]):
        raise ValueError("인식 원문 전체를 CTC 시각에 대응할 수 없습니다")
    path = np.zeros(frames, dtype=np.int32)
    for frame in range(frames - 1, -1, -1):
        path[frame] = state
        state -= int(parents[frame, state])
    result = []
    for index, token in enumerate(tokens):
        selected = np.flatnonzero(path == 2 * index + 1)
        if not selected.size:
            raise ValueError("시각이 없는 글자를 임의로 보간하지 않습니다")
        result.append(dict(start_frame=int(selected[0]), end_frame=int(selected[-1] + 1),
                           mean_log_score=float(log_probs[selected, token].mean())))
    return result
