// Windows only; target a disposable --factory-startup GUI, never a user scene.
import assert from 'node:assert/strict';
import { mkdir, stat, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { request, submit, submitScreenshot, wait } from '../plugins/blender-bridge/skills/blender-bridge/scripts/blender-bridge.mjs';

const [base, directory] = process.argv.slice(2);
if (!base || !directory) throw new Error('Usage: screenshot-smoke.mjs <isolated-url> <new-evidence-directory>');
const output = resolve(directory);
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error('Use an empty evidence directory');
const health = await request(base, '/api/health');
assert.equal(health.background, false);
async function run(code) {
  const job = await submit(base, code);
  const result = await wait(base, job.id);
  assert.equal(result.status, 'succeeded', result.error);
  return JSON.parse(result.result);
}
const stateCode = `import json
from blender_bridge.screenshot import WindowsWindow
w = max(bpy.context.window_manager.windows, key=lambda w: w.width*w.height)
n = WindowsWindow(w)
return json.dumps({'minimized': n.minimized, 'hwnd': n.hwnd, 'scene': [(o.name, list(o.location), list(o.scale)) for o in bpy.data.objects]})`;
const before = await run(stateCode);
const results = { health, before };
for (const minimized of [false, true]) {
  if (minimized) await run(`from blender_bridge.screenshot import WindowsWindow
w = max(bpy.context.window_manager.windows, key=lambda w: w.width*w.height)
n = WindowsWindow(w)
n.api.ShowWindow(n.hwnd, 6)
return 'true'`);
  assert.equal((await run(stateCode)).minimized, minimized);
  const path = join(output, minimized ? 'minimized.png' : 'normal.png');
  const job = await submitScreenshot(base, path);
  const completed = await wait(base, job.id);
  assert.equal(completed.status, 'succeeded', completed.error);
  const meta = JSON.parse(completed.result);
  assert.equal(meta.validated, true);
  assert.equal(meta.restored_minimized, minimized);
  assert.ok(meta.max_rgb > .01 && meta.width > 100 && meta.height > 100);
  assert.ok((await stat(path)).size > 10000);
  const after = await run(stateCode);
  assert.equal(after.minimized, minimized);
  assert.deepEqual(after.scene, before.scene);
  results[minimized ? 'minimized' : 'normal'] = { job: completed, after };
}
const cancelOutput = join(output, 'cancelled.png');
const cancelJob = await submitScreenshot(base, cancelOutput, { interval: 1 });
for (let i = 0; i < 100; i++) {
  const snapshot = await request(base, `/api/jobs/${cancelJob.id}`);
  if (snapshot.steps >= 1) break;
  await new Promise(resolve => setTimeout(resolve, 50));
}
await request(base, `/api/jobs/${cancelJob.id}/cancel`, { method: 'POST', body: {} });
results.cancelled = await wait(base, cancelJob.id);
assert.equal(results.cancelled.status, 'cancelled');
assert.equal((await run(stateCode)).minimized, true);
assert.equal(await stat(cancelOutput).then(() => true, () => false), false);
const existing = join(output, 'normal.png');
const previous = await stat(existing);
const duplicate = await submitScreenshot(base, existing);
results.existing = await wait(base, duplicate.id);
assert.equal(results.existing.status, 'failed');
assert.match(results.existing.error, /already exists/);
assert.equal((await stat(existing)).mtimeMs, previous.mtimeMs);
assert.equal((await run(stateCode)).minimized, true);
await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
