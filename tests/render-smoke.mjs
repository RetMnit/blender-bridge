// Disposable factory-startup GUI only. Does not save a blend file/preferences.
import assert from 'node:assert/strict';
import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { submit, submitRender, request, wait } from '../plugins/blender-bridge/skills/blender-bridge/scripts/blender-bridge.mjs';
const [base, directory]=process.argv.slice(2);
if(!base || !directory)throw new Error('Pass isolated endpoint and new output directory');
const run=async code=>{const j=await submit(base,code);const r=await wait(base,j.id);assert.equal(r.status,'succeeded',JSON.stringify(r));return r;};
const prefs=await run("return str((C.preferences.view.show_splash, C.preferences.use_preferences_save))");
assert.equal(prefs.result,'(True, True)','Startup preference values were not restored');
await run("C.scene.render.engine='CYCLES'\nC.scene.cycles.samples=24\nC.scene.render.resolution_x=480\nC.scene.render.resolution_y=320\nC.scene.render.resolution_percentage=100\nC.preferences.view.render_display_type='NONE'\nreturn 'ready'");
const output=join(directory,'render.png');
const job=await submitRender(base,{output});
console.error(JSON.stringify({id:job.id,base,note:'Query this ID after any test failure; do not resubmit the render.'}));
await assert.rejects(wait(base,job.id,{timeout:.01}),/do not resubmit/);
let running;
for(let i=0;i<200;i++){
  running=await request(base,`/api/jobs/${job.id}`);
  if(running.render?.state==='running')break;
  if(running.status==='failed')throw new Error(running.error);
  await new Promise(r=>setTimeout(r,50));
}
assert.equal(running.status,'running');
assert.equal(running.render.state,'running');
assert.equal((await request(base,'/api/health')).rendering,true);
await assert.rejects(request(base,`/api/jobs/${job.id}/cancel`,{method:'POST',body:{}}),e=>e.status===409 && /Cancel it in Blender/.test(e.message));
const duplicate=await submitRender(base,{output,id:job.id});assert.equal(duplicate.id,job.id);
const final=await wait(base,job.id,{timeout:60});
assert.equal(final.status,'succeeded',JSON.stringify(final));
assert.equal(final.render.state,'completed');
assert((await stat(output)).size>100);
const png=await readFile(output);assert.equal(png.subarray(1,4).toString(),'PNG');
const exists=await submitRender(base,{output});
const failure=await wait(base,exists.id);assert.equal(failure.status,'failed');assert.match(failure.error,/already exists/);
assert.deepEqual(await readFile(output),png);
const missing=await submitRender(base,{scene:'missing-scene'});
assert.equal((await wait(base,missing.id)).status,'failed');
console.log(JSON.stringify({checks:['startup preferences restored','native running state','wait timeout with same-ID recovery','cancel does not detach live renderer','deduplication','completion before success','PNG output','existing file preserved','missing scene rejected'],id:job.id,render:final.render}));
