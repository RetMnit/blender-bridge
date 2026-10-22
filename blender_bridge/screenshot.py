"""Validated GUI capture. All entry points run on Blender's main thread."""
from array import array
import ctypes
import json
import os
from pathlib import Path
import sys
import tempfile

import bpy


class WindowsWindow:
    """Resolve only this process's Blender window, with pointer-safe Win32 types."""
    def __init__(self, window):
        from ctypes import wintypes as wt
        self.api = api = ctypes.WinDLL("user32", use_last_error=True)
        callback_type = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
        signatures = {
            "EnumWindows": ([callback_type, wt.LPARAM], wt.BOOL),
            "GetWindowThreadProcessId": ([wt.HWND, ctypes.POINTER(wt.DWORD)], wt.DWORD),
            "GetClientRect": ([wt.HWND, ctypes.POINTER(wt.RECT)], wt.BOOL),
            "GetClassNameW": ([wt.HWND, wt.LPWSTR, ctypes.c_int], ctypes.c_int),
            "IsIconic": ([wt.HWND], wt.BOOL), "IsWindowVisible": ([wt.HWND], wt.BOOL),
            "ShowWindow": ([wt.HWND, ctypes.c_int], wt.BOOL),
            "GetForegroundWindow": ([], wt.HWND),
            "SetForegroundWindow": ([wt.HWND], wt.BOOL),
        }
        for name, (args, result) in signatures.items():
            fn = getattr(api, name)
            fn.argtypes, fn.restype = args, result
        candidates = []

        @callback_type
        def collect(hwnd, _):
            pid = wt.DWORD()
            api.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            name = ctypes.create_unicode_buffer(256)
            api.GetClassNameW(hwnd, name, len(name))
            if pid.value == os.getpid() and name.value == "GHOST_WindowClass" and api.IsWindowVisible(hwnd):
                rect = wt.RECT()
                if api.GetClientRect(hwnd, ctypes.byref(rect)):
                    size = (rect.right - rect.left, rect.bottom - rect.top)
                    candidates.append((hwnd, size, bool(api.IsIconic(hwnd))))
            return True

        api.EnumWindows(collect, 0)
        # Blender's window dimensions match Win32 client dimensions even while iconic.
        exact = [item for item in candidates if item[1] == (window.width, window.height)]
        if len(exact) == 1:
            selected = exact[0]
        elif len(candidates) == 1:
            selected = candidates[0]
        else:
            raise RuntimeError("Cannot unambiguously identify this Blender window; close extra windows or restore it manually")
        self.hwnd, _, self.minimized = selected
        self.foreground = api.GetForegroundWindow()

    def restore(self):
        if self.minimized:
            self.api.ShowWindow(self.hwnd, 9)  # SW_RESTORE; redraw happens at yielded ticks.
            if self.api.IsIconic(self.hwnd):
                raise RuntimeError("Windows did not restore the minimized Blender window")

    def cleanup(self):
        if self.minimized:
            self.api.ShowWindow(self.hwnd, 6)  # SW_MINIMIZE
        # Do not steal focus from an app the user selected during capture.
        if self.foreground and self.api.GetForegroundWindow() == self.hwnd:
            self.api.SetForegroundWindow(self.foreground)


def pixel_stats(image):
    """Ignore alpha: an opaque black framebuffer must never pass validation."""
    count = len(image.pixels)
    channels = image.channels
    if channels < 3 or not count:
        raise RuntimeError("Screenshot has no RGB pixels")
    pixels = array('f', [0.0]) * count
    image.pixels.foreach_get(pixels)
    peak = max(max(pixels[channel::channels]) for channel in range(3))
    mean = sum(sum(pixels[channel::channels]) for channel in range(3)) / (count // channels * 3)
    return {"max_rgb": float(peak), "mean_rgb": float(mean)}


def capture(output):
    """Generator: restore, redraw, capture and validate, then restore window state."""
    target = Path(output)
    if not target.is_absolute() or target.suffix.lower() != ".png":
        raise ValueError("Screenshot output must be an absolute .png path")
    if target.exists():
        raise FileExistsError("Screenshot output already exists; choose a new path")
    if bpy.app.background:
        raise RuntimeError("Screenshot requires a GUI Blender instance")
    windows = list(bpy.context.window_manager.windows)
    if not windows:
        raise RuntimeError("No Blender GUI window is available")
    window = max(windows, key=lambda item: item.width * item.height)
    native = WindowsWindow(window) if sys.platform == "win32" else None
    temporary = None
    try:
        if native:
            native.restore()
        # Release the event loop twice: restoring queues resize/expose events before drawing.
        for _ in range(2):
            for area in window.screen.areas:
                area.tag_redraw()
            yield "Preparing Blender window for screenshot"
        if native and native.api.IsIconic(native.hwnd):
            raise RuntimeError("Blender was minimized during capture; screenshot aborted")
        fd, name = tempfile.mkstemp(prefix=".blender-bridge-", suffix=".png", dir=target.parent)
        os.close(fd)
        temporary = Path(name)
        with bpy.context.temp_override(window=window):
            result = bpy.ops.screen.screenshot(filepath=str(temporary))
        if "FINISHED" not in result:
            raise RuntimeError("Blender screenshot operator did not finish")
        image = bpy.data.images.load(str(temporary), check_existing=False)
        try:
            stats = pixel_stats(image)
            width, height = image.size
        finally:
            bpy.data.images.remove(image)
        if stats["max_rgb"] <= 1 / 255:
            raise RuntimeError("Screenshot is black; no output published. Restore Blender and query/inspect before retrying")
        # Publish only after validation, and never overwrite an existing file (including races).
        if sys.platform == "win32":
            os.rename(temporary, target)  # Windows rename fails when target exists.
        else:
            os.link(temporary, target)
        return json.dumps({"path": str(target), "width": width, "height": height,
                           "restored_minimized": bool(native and native.minimized),
                           "validated": True, **stats})
    finally:
        try:
            if temporary:
                temporary.unlink(missing_ok=True)
        finally:
            if native:
                native.cleanup()
