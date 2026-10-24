"""A tracked, nonblocking still render. All orchestration runs on the GUI thread."""
import json
import os
from pathlib import Path
import tempfile
import time

import bpy


def render_still(output=None, scene_name=None):
    from .server import bridge, JobCancelled

    if bpy.app.background:
        raise RuntimeError("Tracked render requires GUI Blender (INVOKE_DEFAULT)")
    if bpy.app.is_job_running('RENDER'):
        raise RuntimeError("A Blender render is already running; do not start another")
    scene = bpy.data.scenes.get(scene_name) if scene_name else bpy.context.scene
    if scene is None:
        raise ValueError("Unknown render scene")
    if scene.camera is None:
        raise ValueError("Render scene has no camera")
    target = Path(output) if output is not None else None
    if target:
        if not target.is_absolute() or target.suffix.lower() != '.png':
            raise ValueError("Render output must be a new absolute .png path")
        if target.exists():
            raise FileExistsError("Render output already exists; choose a new path")
        if not target.parent.is_dir():
            raise ValueError("Render output parent directory does not exist")
    window = bpy.context.window
    if window is None:
        raise RuntimeError("Render requires a Blender GUI window")
    job = bridge.active
    if job is None:
        raise RuntimeError("Render must run as a bridge job")
    started = time.monotonic()
    signal = {'complete': False, 'cancelled': False}
    handlers = []
    temporary = None

    def update(state):
        job['render'] = {'state': state, 'scene': scene.name,
                         'elapsed_seconds': round(time.monotonic() - started, 2),
                         'output': str(target) if target else None}

    def on_complete(render_scene, *args):
        if render_scene == scene:
            signal['complete'] = True

    def on_cancel(render_scene, *args):
        if render_scene == scene:
            signal['cancelled'] = True

    try:
        # Do not register render_stats: some Blender builds pass a null native
        # string to the Python callback, crashing before Python can validate it.
        for name, callback in [('render_complete', on_complete), ('render_cancel', on_cancel)]:
            collection = getattr(bpy.app.handlers, name)
            collection.append(callback)
            handlers.append((collection, callback))
        # Generic generator cancellation cannot safely cancel Blender's native job.
        # Keep tracking it; an explicit cancel is rejected with UI cancellation guidance.
        job['cancel_policy'] = 'native-render'
        update('starting')
        with bpy.context.temp_override(window=window):
            result = bpy.ops.render.render('INVOKE_DEFAULT', scene=scene.name, write_still=False)
        bridge.update_health()
        if 'RUNNING_MODAL' not in result and 'FINISHED' not in result:
            raise RuntimeError('Blender did not start rendering: ' + str(result))
        while True:
            running = bpy.app.is_job_running('RENDER')
            update('running' if running else 'finishing')
            # A completion handler can precede native-job teardown. Wait for both.
            if not running and (signal['complete'] or signal['cancelled']):
                break
            if not running and time.monotonic() - started > 10:
                raise RuntimeError('Render ended without a completion/cancel signal; result not published')
            yield 'Rendering %s (%.1fs)' % (scene.name, time.monotonic() - started)
        if signal['cancelled']:
            update('cancelled')
            raise JobCancelled('Render cancelled in Blender; no output published')
        if target:
            image = bpy.data.images.get('Render Result')
            if image is None:
                raise RuntimeError('Completed render has no Render Result')
            fd, name = tempfile.mkstemp(prefix='.blender-bridge-render-', suffix='.png', dir=target.parent)
            os.close(fd)
            temporary = Path(name)
            previous_format = scene.render.image_settings.file_format
            try:
                scene.render.image_settings.file_format = 'PNG'
                image.save_render(str(temporary), scene=scene)
            finally:
                scene.render.image_settings.file_format = previous_format
            if temporary.stat().st_size == 0:
                raise RuntimeError('Render output is empty')
            # No overwrite, including a file created by somebody else during rendering.
            if os.name == 'nt':
                os.rename(temporary, target)
            else:
                os.link(temporary, target)
        update('completed')
        return json.dumps(job['render'])
    except JobCancelled:
        raise
    except GeneratorExit:
        update('interrupted')
        raise
    except BaseException:
        update('failed')
        raise
    finally:
        bridge.update_health()
        for collection, callback in handlers:
            if callback in collection:
                collection.remove(callback)
        job.pop('cancel_policy', None)
        if temporary:
            temporary.unlink(missing_ok=True)
