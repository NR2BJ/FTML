"""검사 명령에서만 사용하는 단계별 기록. 운영 응답이나 로그에는 대사를 넣지 않는다."""

import json
import math
import os


def serializable(value):
    if isinstance(value, dict):
        return {key: serializable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [serializable(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return {name: serializable(getattr(value, name)) for name in ("word", "text", "start_ts", "end_ts")
            if hasattr(value, name)}


class TraceWriter:
    def __init__(self, path, max_bytes=16 * 1024 * 1024):
        self.stream = os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf-8")
        self.remaining = max_bytes

    def __call__(self, stage, **values):
        line = json.dumps(serializable(dict(stage=stage, **values)), ensure_ascii=False, allow_nan=False) + "\n"
        self.remaining -= len(line.encode("utf-8"))
        if self.remaining < 0:
            raise ValueError("단계별 검사 기록이 16MiB 한도를 초과했습니다")
        self.stream.write(line)
        self.stream.flush()

    def close(self):
        self.stream.close()


def emit(trace, stage, **values):
    if trace is not None:
        trace(stage, **values)
