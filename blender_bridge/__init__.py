"""Blender Bridge: shared local executor for agents."""
import bpy
from bpy.app.handlers import persistent
from .server import bridge

bl_info = {"name": "Blender Bridge", "author": "RetMnit", "version": (0, 2, 0),
           "blender": (3, 6, 0), "location": "3D View > Sidebar > Bridge",
           "description": "Agent-neutral local Python bridge with visible generator steps", "category": "Development"}


class BridgeStart(bpy.types.Operator):
    bl_idname = "wm.blender_bridge_start"
    bl_label = "Start Bridge"
    def execute(self, context):
        bridge.start()
        return {"FINISHED"}


class BridgeStop(bpy.types.Operator):
    bl_idname = "wm.blender_bridge_stop"
    bl_label = "Stop Bridge"
    def execute(self, context):
        bridge.stop()
        return {"FINISHED"}


class BridgePanel(bpy.types.Panel):
    bl_label = "Blender Bridge"
    bl_idname = "VIEW3D_PT_blender_bridge"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Bridge"
    def draw(self, context):
        self.layout.label(text=bridge.health.get("url", "Stopped") if bridge.running else "Stopped")
        self.layout.label(text=bridge.last_status[:110])
        self.layout.operator("wm.blender_bridge_stop" if bridge.running else "wm.blender_bridge_start")


@persistent
def on_load(_):
    # Never resume a generator from the previous scene after loading a file.
    if bridge.running:
        bridge.stop()
        bridge.start()


classes = (BridgeStart, BridgeStop, BridgePanel)


def autostart():
    # addon_utils.register runs with RestrictedData/Context during startup.
    # Wait for a normal main-thread event before inspecting the scene.
    bridge.start()
    return None


def register():
    for cls in classes:
        bpy.utils.register_class(cls)
    bpy.app.handlers.load_post.append(on_load)
    bpy.app.timers.register(autostart, first_interval=0.2, persistent=True)


def unregister():
    if bpy.app.timers.is_registered(autostart):
        bpy.app.timers.unregister(autostart)
    bridge.stop()
    if on_load in bpy.app.handlers.load_post:
        bpy.app.handlers.load_post.remove(on_load)
    for cls in reversed(classes):
        bpy.utils.unregister_class(cls)
