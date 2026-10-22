# Only in the factory-startup GUI. Pass an existing absolute directory in BRIDGE_TEST_OUTPUT.
import os
from pathlib import Path
output = Path(os.environ['BRIDGE_TEST_OUTPUT'])
cube = bpy.data.objects['Cube']
cube.scale = (0.5, 0.5, 0.5)
yield 'Step 1: small cube'
bpy.ops.screen.screenshot(filepath=str(output / 'step-1.png'))
cube.scale = (1, 1, 2.5)
yield 'Step 2: tall block'
bpy.ops.screen.screenshot(filepath=str(output / 'step-2.png'))
bpy.ops.mesh.primitive_uv_sphere_add(radius=1, location=(3, 0, 1))
yield 'Step 3: sphere added'
bpy.ops.screen.screenshot(filepath=str(output / 'step-3.png'))
return 'Three separate visible redraws verified by screenshots'
