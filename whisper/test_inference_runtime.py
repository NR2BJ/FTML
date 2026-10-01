import threading
import unittest

from inference_runtime import ModelGate


class ModelGateTests(unittest.TestCase):
    def test_stale_idle_callback_cannot_unload_new_activity(self):
        gate = ModelGate(60)
        self.addCleanup(gate.close)
        unloaded = []
        gate.on_idle = lambda: unloaded.append(True)
        operation = gate.operation(lambda: None)
        operation()
        stale = gate._generation
        operation()
        gate._unload(stale)
        self.assertEqual(unloaded, [])
        gate._unload(gate._generation)
        self.assertEqual(unloaded, [True])

    def test_model_operations_never_overlap(self):
        gate = ModelGate(0)
        self.addCleanup(gate.close)
        started, release, second = threading.Event(), threading.Event(), threading.Event()

        @gate.operation
        def first():
            started.set()
            release.wait(2)

        one = threading.Thread(target=first)
        two = threading.Thread(target=gate.operation(second.set))
        one.start()
        self.assertTrue(started.wait(1))
        two.start()
        try:
            self.assertFalse(second.wait(0.03))
        finally:
            release.set()
            one.join(2)
            two.join(2)
        self.assertTrue(second.is_set())

    def test_exception_releases_gate(self):
        gate = ModelGate(0)
        @gate.operation
        def fail():
            raise ValueError("failed inference")
        with self.assertRaises(ValueError):
            fail()
        self.assertEqual(gate.active, 0)
        self.assertEqual(gate.operation(lambda: 42)(), 42)


if __name__ == "__main__":
    unittest.main()
