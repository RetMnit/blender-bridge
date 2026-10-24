"""Native-render lifecycle regressions without a Blender process."""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

fake = types.SimpleNamespace()
spec = importlib.util.spec_from_file_location('blender_bridge.render', Path(__file__).resolve().parents[1] / 'blender_bridge/render.py')
module = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, bpy=fake):
    spec.loader.exec_module(module)

class Cancelled(Exception):
    pass

class RenderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name) / 'render.png'
        self.job = {}
        self.running = False
        self.calls = 0
        self.handlers = types.SimpleNamespace(render_complete=[], render_cancel=[], render_stats=[])
        self.scene = types.SimpleNamespace(name='Scene', camera=object(), render=types.SimpleNamespace(image_settings=types.SimpleNamespace(file_format='OPEN_EXR')))
        fake.app = types.SimpleNamespace(background=False, is_job_running=lambda _: self.running, handlers=self.handlers)
        fake.context = types.SimpleNamespace(scene=self.scene, window=object(), temp_override=lambda **kw: contextlib.nullcontext())
        fake.data = types.SimpleNamespace(scenes=types.SimpleNamespace(get=lambda name: self.scene if name=='Scene' else None), images=types.SimpleNamespace(get=lambda name: types.SimpleNamespace(save_render=self.save)))
        fake.ops = types.SimpleNamespace(render=types.SimpleNamespace(render=self.start))
        self.addCleanup(patch.stopall)
        patch.dict(sys.modules, {'blender_bridge.server': types.SimpleNamespace(bridge=types.SimpleNamespace(active=self.job, update_health=lambda: None), JobCancelled=Cancelled)}).start()

    def start(self, *args, **kw):
        self.calls += 1
        self.running = True
        return {'RUNNING_MODAL'}

    def save(self, path, **kw):
        Path(path).write_bytes(b'new render')

    def complete(self):
        for cb in self.handlers.render_complete[:]: cb(self.scene)

    def test_waits_for_handler_and_native_teardown(self):
        gen=module.render_still(str(self.output))
        next(gen)
        self.assertEqual(self.job['render']['state'], 'running')
        self.assertFalse(self.output.exists())
        self.complete()
        next(gen)  # handler alone is not enough
        self.running=False
        with self.assertRaises(StopIteration) as result: next(gen)
        self.assertEqual(json.loads(result.exception.value)['state'], 'completed')
        self.assertEqual(self.output.read_bytes(), b'new render')
        self.assertEqual(self.scene.render.image_settings.file_format,'OPEN_EXR')
        self.assertEqual(self.handlers.render_complete,[])
        self.assertNotIn('cancel_policy',self.job)

    def test_ui_cancel_never_publishes_stale_result(self):
        gen=module.render_still(str(self.output));next(gen)
        self.handlers.render_cancel[0](self.scene);self.running=False
        with self.assertRaises(Cancelled):next(gen)
        self.assertEqual(self.job['render']['state'],'cancelled')
        self.assertFalse(self.output.exists())
        self.assertEqual(self.handlers.render_cancel,[])

    def test_bridge_stop_detaches_without_claiming_native_cancellation(self):
        gen=module.render_still();next(gen);gen.close()
        self.assertTrue(self.running)
        self.assertEqual(self.job['render']['state'],'interrupted')
        self.assertEqual(self.handlers.render_complete,[])

    def test_existing_output_and_busy_renderer_rejected_before_start(self):
        self.output.write_bytes(b'original')
        with self.assertRaises(FileExistsError):next(module.render_still(str(self.output)))
        self.running=True
        with self.assertRaisesRegex(RuntimeError,'already running'):next(module.render_still())
        self.assertEqual(self.calls,0)
        self.assertEqual(self.output.read_bytes(),b'original')

    def test_output_race_preserves_user_file(self):
        gen=module.render_still(str(self.output));next(gen)
        self.output.write_bytes(b'created during render')
        self.complete();self.running=False
        with self.assertRaises(FileExistsError):next(gen)
        self.assertEqual(self.output.read_bytes(),b'created during render')
        self.assertEqual(list(self.output.parent.iterdir()),[self.output])

    def test_failed_save_restores_settings_and_removes_temporary_file(self):
        def fail(*a,**kw):raise RuntimeError('disk error')
        self.save=fail
        gen=module.render_still(str(self.output));next(gen);self.complete();self.running=False
        with self.assertRaisesRegex(RuntimeError,'disk error'):next(gen)
        self.assertEqual(self.scene.render.image_settings.file_format,'OPEN_EXR')
        self.assertEqual(list(self.output.parent.iterdir()),[])

    def test_missing_completion_is_not_success(self):
        with patch.object(module.time,'monotonic',return_value=0):
            gen=module.render_still();next(gen)
        self.running=False
        with patch.object(module.time,'monotonic',return_value=11):
            with self.assertRaisesRegex(RuntimeError,'without a completion'):next(gen)
        self.assertEqual(self.job['render']['state'],'failed')

if __name__=='__main__':unittest.main()
