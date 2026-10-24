"""Suppress only the automatic startup splash; never save user preferences."""
import bpy

_saved = None


def restore():
    global _saved
    if _saved is not None:
        prefs, splash, autosave = _saved
        _saved = None
        prefs.view.show_splash = splash
        prefs.use_preferences_save = autosave
    return None


def suppress_startup_splash():
    global _saved
    if bpy.app.background or _saved is not None:
        return
    prefs = bpy.context.preferences
    _saved = (prefs, prefs.view.show_splash, prefs.use_preferences_save)
    prefs.use_preferences_save = False
    prefs.view.show_splash = False
    # Startup draws the splash before the GUI timer loop. Restore after startup;
    # subsequent user-requested Help > Splash Screen remains available.
    bpy.app.timers.register(restore, first_interval=1.0, persistent=True)


def cleanup():
    if bpy.app.timers.is_registered(restore):
        bpy.app.timers.unregister(restore)
    restore()
