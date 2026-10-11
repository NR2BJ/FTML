import json
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from extraction_trace import TraceWriter, emit


class TraceTests(unittest.TestCase):
    def test_snapshots_are_immutable_private_and_never_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'stages.jsonl'
            trace = TraceWriter(path)
            word = SimpleNamespace(word='대사', start_ts=0, end_ts=float('nan'))
            emit(trace, 'raw', words=[word])
            word.word = '변경'
            trace.close()
            self.assertEqual(json.loads(path.read_text())['words'][0], dict(word='대사', start_ts=0, end_ts='nan'))
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            with self.assertRaises(FileExistsError):
                TraceWriter(path)

    def test_record_limit_does_not_write_partial_json(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'limited.jsonl'
            trace = TraceWriter(path, max_bytes=10)
            try:
                with self.assertRaises(ValueError):
                    trace('large', text='a'*100)
            finally:
                trace.close()
            self.assertEqual(path.read_bytes(), b'')
        emit(None, 'no_record', text='대사')

    def test_probe_refuses_mac_before_importing_model_libraries(self):
        import alignment_probe
        import benchmark
        with patch.object(sys, 'platform', 'darwin'):
            with self.assertRaises(SystemExit):
                benchmark.main()
            with patch.object(sys, 'argv', ['probe', 'whisper-native', '--inputs', 'missing', '--model-path', 'missing', '--output', 'missing']):
                with self.assertRaises(SystemExit):
                    alignment_probe.main()


if __name__ == '__main__':
    unittest.main()
