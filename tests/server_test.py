"""Pure queue/lifecycle regression tests; fake bpy, no user scene."""
import importlib.util
from pathlib import Path
import sys
import types
import unittest

registered = set()
timers = types.SimpleNamespace(is_registered=lambda fn: fn in registered,
                               register=lambda fn, **kw: registered.add(fn),
                               unregister=lambda fn: registered.remove(fn))
sys.modules['bpy'] = types.SimpleNamespace(app=types.SimpleNamespace(version_string='fake', background=False, timers=timers),
                                         data=types.SimpleNamespace(filepath=''),
                                         context=types.SimpleNamespace(window_manager=types.SimpleNamespace(windows=[])))
sys.modules['mathutils'] = types.SimpleNamespace()
spec = importlib.util.spec_from_file_location('bridge_server', Path(__file__).resolve().parents[1] / 'blender_bridge/server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class QueueTests(unittest.TestCase):
    def make_bridge(self):
        bridge = server.Bridge()
        bridge.enabled = True
        bridge.thread = types.SimpleNamespace(is_alive=lambda: True)
        return bridge

    def test_evicted_cancelled_queue_ids_do_not_break_timer(self):
        bridge = self.make_bridge()
        for i in range(140):
            bridge.submit({'id': str(i), 'code': 'return 9'})
            bridge.cancel(str(i))
        self.assertEqual(len(bridge.jobs), 128)
        bridge.submit({'id': 'final', 'code': "print('done')\nreturn 42"})
        bridge.poll()
        snap = bridge.snapshot('final')
        self.assertEqual(snap['status'], 'succeeded')
        self.assertEqual(snap['logs'], ['done'])
        self.assertEqual(snap['result'], '42')

    def test_one_step_per_tick_and_stop_stays_stopped(self):
        bridge = self.make_bridge()
        job, _ = bridge.submit({'id': 'steps', 'code': "yield 'first'\nyield 'second'\nreturn 3"})
        bridge.poll()
        self.assertEqual(job['steps'], 1)
        self.assertEqual(job['status'], 'running')
        bridge.stop()
        self.assertEqual(job['status'], 'interrupted')
        self.assertIsNone(bridge.poll())
        self.assertFalse(bridge.enabled)

    def test_distinct_listeners_and_descriptor_cleanup(self):
        first, second = server.Bridge(), server.Bridge()
        try:
            first.start(port=0)
            second.start(port=first.httpd.server_port)
            self.assertNotEqual(first.httpd.server_port, second.httpd.server_port)
            descriptor = second.descriptor
            second.stop()
            self.assertFalse(descriptor.exists())
        finally:
            first.stop()
            second.stop()


if __name__ == '__main__':
    unittest.main()
