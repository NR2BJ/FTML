"""One owner for model use, model replacement, and idle unloading."""

from functools import wraps
import errno
import threading


STORAGE_FULL_MESSAGE = (
    "음성 인식 서버의 저장 공간 또는 파일 개수 한도(inode)가 부족합니다. "
    "모델·임시 파일 저장소의 여유 공간을 확보한 뒤 다시 시도해 주세요."
)


class StorageFullError(RuntimeError):
    def __init__(self):
        super().__init__(STORAGE_FULL_MESSAGE)


def is_storage_full(error):
    return isinstance(error, StorageFullError) or (
        isinstance(error, OSError) and error.errno in (errno.ENOSPC, errno.EDQUOT)
    )


class ModelGate:
    def __init__(self, idle_timeout):
        self.lock = threading.RLock()
        self.idle_timeout = idle_timeout
        self.on_idle = lambda: None
        self.active = 0
        self._timer = None
        self._generation = 0
        self._closed = False

    def operation(self, function):
        @wraps(function)
        def wrapped(*args, **kwargs):
            with self.lock:
                self._generation += 1
                if self._timer is not None:
                    self._timer.cancel()
                    self._timer = None
                self.active += 1
                try:
                    return function(*args, **kwargs)
                finally:
                    self.active -= 1
                    if self.active == 0 and self.idle_timeout > 0 and not self._closed:
                        self._timer = threading.Timer(self.idle_timeout, self._unload, (self._generation,))
                        self._timer.daemon = True
                        self._timer.start()
        return wrapped

    def _unload(self, generation):
        with self.lock:
            if self._closed or generation != self._generation or self.active:
                return
            self._timer = None
            self.on_idle()

    def close(self):
        with self.lock:
            self._closed = True
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
