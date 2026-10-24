import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

class StartupTests(unittest.TestCase):
    def test_splash_suppression_is_temporary_and_preserves_preferences(self):
        callbacks=[]
        prefs=types.SimpleNamespace(view=types.SimpleNamespace(show_splash=True),use_preferences_save=True)
        timers=types.SimpleNamespace(register=lambda fn,**kw:callbacks.append(fn),is_registered=lambda fn:fn in callbacks,unregister=callbacks.remove)
        fake=types.SimpleNamespace(context=types.SimpleNamespace(preferences=prefs),app=types.SimpleNamespace(background=False,timers=timers))
        spec=importlib.util.spec_from_file_location('startup_test_module',Path(__file__).resolve().parents[1]/'blender_bridge/startup.py')
        module=importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules,bpy=fake):spec.loader.exec_module(module)
        module.suppress_startup_splash()
        self.assertFalse(prefs.view.show_splash)
        self.assertFalse(prefs.use_preferences_save)
        module.suppress_startup_splash()
        self.assertEqual(len(callbacks),1)
        module.cleanup()
        self.assertTrue(prefs.view.show_splash)
        self.assertTrue(prefs.use_preferences_save)
        self.assertEqual(callbacks,[])
        fake.app.background=True;module.suppress_startup_splash()
        self.assertEqual(callbacks,[])

if __name__=='__main__':unittest.main()
