// Only run on the disposable bootstrap_gui instance, with a disposable absolute blend path.
import assert from 'node:assert/strict';
import { request, submit, wait, discover } from '../plugins/blender-bridge/skills/blender-bridge/scripts/blender-bridge.mjs';
const [base, file] = process.argv.slice(2);
if (!base || !file) throw new Error('isolated URL and disposable absolute .blend path required');
const original = await request(base, '/api/health');
const saved = await submit(base, `bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(file)})\nreturn 'saved'`);
assert.equal((await wait(base, saved.id)).status, 'succeeded');
const opened = await submit(base, `bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(file)})\nreturn 'opened'`);
await new Promise(done => setTimeout(done, 2000));
const target = (await discover()).find(item => item.pid === original.pid);
assert.ok(target, 'bridge survives load');
assert.equal((await request(target.url, `/api/jobs/${opened.id}`)).status, 'interrupted');
const next = await submit(target.url, 'return 123');
assert.equal((await wait(target.url, next.id)).result, '123');
console.log('PASS: file load interrupts current write, refreshes discovery, never replays, and accepts next command at ' + target.url);
