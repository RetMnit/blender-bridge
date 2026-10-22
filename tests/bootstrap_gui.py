"""Launch only in an isolated --factory-startup test instance; never saves preferences."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import blender_bridge
blender_bridge.register()
