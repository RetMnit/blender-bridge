"""Screenshot lifecycle tests with fake framebuffer and real temporary files."""
import contextlib
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

fake_bpy = types.SimpleNamespace()
with patch.dict(sys.modules, bpy=fake_bpy):
    spec = importlib.util.spec_from_file_location('capture_test_module', Path(__file__).resolve().parents[1] / 'blender_bridge/screenshot.py')
    shot = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(shot)


class Pixels(list):
    def foreach_get(self, target):
        target[:] = type(target)('f', self)


class ScreenshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name) / 'capture.png'
        self.native = types.SimpleNamespace(minimized=True, hwnd=7,
            restore=lambda: self.events.append('restore'), cleanup=lambda: self.events.append('cleanup'),
            api=types.SimpleNamespace(IsIconic=lambda _: False))
        self.events = []
        self.image = types.SimpleNamespace(pixels=Pixels([0, .2, .4, 1]), channels=4, size=(1, 1))
        fake_bpy.app = types.SimpleNamespace(background=False)
        fake_bpy.context = types.SimpleNamespace(
            window_manager=types.SimpleNamespace(windows=[types.SimpleNamespace(width=1, height=1,
                screen=types.SimpleNamespace(areas=[]))]), temp_override=lambda **_: contextlib.nullcontext())
        fake_bpy.data = types.SimpleNamespace(images=types.SimpleNamespace(
            load=lambda *a, **kw: self.image, remove=lambda _: self.events.append('remove_image')))
        def screenshot(filepath):
            Path(filepath).write_bytes(b'captured')
            return {'FINISHED'}
        fake_bpy.ops = types.SimpleNamespace(screen=types.SimpleNamespace(screenshot=screenshot))
        self.addCleanup(patch.stopall)
        patch.object(shot.sys, 'platform', 'win32').start()
        patch.object(shot, 'WindowsWindow', lambda window: self.native).start()

    def finish(self, gen):
        try:
            while True:
                next(gen)
        except StopIteration as stop:
            return stop.value

    def test_minimized_capture_validates_before_publish_and_restores(self):
        result = self.finish(shot.capture(str(self.output)))
        self.assertIn('"validated": true', result)
        self.assertEqual(self.output.read_bytes(), b'captured')
        self.assertEqual(self.events, ['restore', 'remove_image', 'cleanup'])
        self.assertEqual(list(self.output.parent.iterdir()), [self.output])

    def test_black_rgb_with_opaque_alpha_is_rejected(self):
        self.image.pixels = Pixels([0, 0, 0, 1])
        with self.assertRaisesRegex(RuntimeError, 'Screenshot is black'):
            self.finish(shot.capture(str(self.output)))
        self.assertEqual(list(self.output.parent.iterdir()), [])
        self.assertEqual(self.events[-1], 'cleanup')

    def test_cancel_before_capture_restores_window(self):
        gen = shot.capture(str(self.output))
        next(gen)
        gen.close()
        self.assertEqual(self.events, ['restore', 'cleanup'])
        self.assertFalse(self.output.exists())

    def test_capture_failure_restores_and_removes_temporary_file(self):
        def fail(**kw):
            raise RuntimeError('GPU capture failed')
        fake_bpy.ops.screen.screenshot = fail
        with self.assertRaisesRegex(RuntimeError, 'GPU capture failed'):
            self.finish(shot.capture(str(self.output)))
        self.assertEqual(list(self.output.parent.iterdir()), [])
        self.assertEqual(self.events[-1], 'cleanup')

    def test_existing_output_is_preserved_without_restoring_window(self):
        self.output.write_bytes(b'user file')
        with self.assertRaises(FileExistsError):
            next(shot.capture(str(self.output)))
        self.assertEqual(self.output.read_bytes(), b'user file')
        self.assertEqual(self.events, [])

    def test_background_is_rejected(self):
        fake_bpy.app.background = True
        with self.assertRaisesRegex(RuntimeError, 'GUI'):
            next(shot.capture(str(self.output)))
        self.assertEqual(self.events, [])

    @unittest.skipUnless(os.name == 'nt', 'Windows no-replace rename')
    def test_output_created_during_capture_is_preserved(self):
        original = fake_bpy.ops.screen.screenshot
        def raced(filepath):
            result = original(filepath)
            self.output.write_bytes(b'new user file')
            return result
        fake_bpy.ops.screen.screenshot = raced
        with self.assertRaises(FileExistsError):
            self.finish(shot.capture(str(self.output)))
        self.assertEqual(self.output.read_bytes(), b'new user file')
        self.assertEqual(list(self.output.parent.iterdir()), [self.output])
        self.assertEqual(self.events[-1], 'cleanup')


if __name__ == '__main__':
    unittest.main()
