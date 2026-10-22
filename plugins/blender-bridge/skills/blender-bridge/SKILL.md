---
name: blender-bridge
description: Inspect and operate a running Blender through the shared local Blender Bridge. Supports visible generator steps, instance discovery, screenshots, and job recovery. Use for live Blender work after the addon is installed.
---

# Blender Bridge

Use Node 22+ with the bundled `scripts/blender-bridge.mjs`, resolving the path relative to this skill. This is a CLI, not an MCP server.

1. Run `node <client> list`. Select the intended instance by `--pid <PID>` or `--url <URL>` on every command. `health` reports Blender version, file, PID and session. Never assume the first instance or a fixed port is the intended scene.
2. Submit `exec --file <UTF-8.py>`. Code is a Python function body with `bpy`, `C`, `D`, `context`, and `mathutils`. Return values are strings; print output is captured. Inspect before editing user scene/configuration; do not save unrelated user changes. Script changes do not automatically create Undo history or save the blend file.
3. **Make operations visible:** use `yield 'step description'` between short modeling steps. Each yield returns control to Blender's GUI, tags all areas for redraw and waits `--interval 0.2` seconds (0.05–10). Ordinary code runs synchronously on the main thread; long operations, render calls, sleep and loops without yield freeze the GUI until they return. Yield does not display objects hidden or outside the current viewport; inspect context before changing the user's layout/view. Do not use background Blender for work the user should watch.
4. Each exec prints its ID and endpoint before submission. A timeout, disconnect or interrupted wait is **not cancellation**. Use `status <id>` or `wait <id>` on that same endpoint; never repeat the write with a new ID. Same-ID/same-payload is deduplicated only while the in-memory record is retained (up to 128 jobs). Session restart/unknown/evicted ID requires inspecting scene state before retry. No jobs are replayed after restart. Capture the session from health when resolving uncertainty.
5. `cancel <id>` prevents queued execution; a running generator stops between steps, preserving earlier mutations. Running synchronous code cannot be safely preempted. Queue TTL (`--ttl 30`, max 3600 seconds) only limits time before execution begins.
6. Use `screenshot --output <new absolute.png>` (addon 0.3.0+) for validated capture, then view the PNG. On Windows a minimized target is temporarily restored for two redraw ticks and minimized again after capture, failure or cancellation. The largest Blender window is selected within this process; ambiguous native windows fail safely. RGB black captures fail without publishing output; existing files are never overwritten. Requires GUI; automatic minimized-window restoration is Windows-only. Raw `bpy.ops.screen.screenshot` bypasses these safeguards. A wait timeout still requires querying the original job ID; it does not cancel capture.

```text
node <client> list
node <client> health --pid <pid>
node <client> exec --pid <pid> --file <steps.py> --interval 0.3 --no-wait
node <client> wait <id> --pid <pid> --timeout 120
node <client> screenshot --pid <pid> --output <new.png>
```

Example Python body (use a disposable scene for demonstrations):

```python
bpy.ops.mesh.primitive_cube_add(location=(0, 0, 0))
cube = bpy.context.object
yield 'Cube created'
cube.scale.z = 2
yield 'Cube stretched'
return cube.name
```

Exit 0 means succeeded/accepted, 1 means failed/rejected, 2 means wait expired and the outcome remains unknown. `--no-wait` returning queued does not prove completion. Local HTTP is bound to loopback with browser Origin requests rejected; it still grants trusted local processes arbitrary Python access. Do not expose it to the network. Discovery descriptors live under the OS temporary `blender-bridge` directory and are verified by PID/session against health.
