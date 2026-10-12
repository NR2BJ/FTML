"""공식 Qwen 시각 보간을 관측한다. 모델이나 보간 결과 자체는 바꾸지 않는다."""

from copy import copy


def capture_timestamps(aligner):
    """호출별 복사본에만 관측기를 붙여 다른 작업의 분절기를 건드리지 않는다."""
    observed = []
    local = copy(aligner)
    local.aligner_processor = copy(aligner.aligner_processor)
    fix = local.aligner_processor.fix_timestamp

    def capture(values):
        fixed = fix(values)
        observed.append((values.tolist(), list(fixed)))
        return fixed

    local.aligner_processor.fix_timestamp = capture
    return local, observed


def mark_interpolated(words, observed):
    """정상 길이를 가진 단어라도 보간한 끝점이 있으면 측정된 시각과 구분한다."""
    if len(observed) != 1 or any(len(values) != 2 * len(words) for values in observed[0]):
        raise ValueError("Qwen 시각 보간 관측과 반환 단어 수가 다릅니다")
    raw, fixed = observed[0]
    result = []
    for index, word in enumerate(words):
        # 공식 반환의 정수 밀리초 절삭은 보간으로 세지 않는다.
        repaired = any(abs(raw[i] - fixed[i]) > 1 for i in (index*2, index*2+1))
        result.append(dict(word, **({"_timing_uncertain": True} if repaired else {})))
    return result
