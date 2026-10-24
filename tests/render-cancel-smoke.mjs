// Disposable GUI only. After the job ID prints, cancel via the real Render UI.
// Blender's simulated ESC events do not reliably set its native render break flag.
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { submit, submitRender, wait } from '../plugins/blender-bridge/skills/blender-bridge/scripts/blender-bridge.mjs';
const [base, output]=process.argv.slice(2);
if(!base || !output)throw new Error('Pass isolated endpoint and new .png output');
const setup=await submit(base,`
C.scene.render.engine='CYCLES'
C.scene.cycles.samples=10000
C.scene.cycles.use_adaptive_sampling=False
C.scene.render.resolution_x=1000
C.scene.render.resolution_y=1000
C.preferences.view.render_display_type='WINDOW'
return 'ready for real UI cancellation'`);
assert.equal((await wait(base,setup.id)).status,'succeeded');
const job=await submitRender(base,{output});
console.error(JSON.stringify({id:job.id,base,note:'Cancel this isolated render in Blender now; timeout does not cancel it.'}));
const result=await wait(base,job.id,{timeout:60});
assert.equal(result.status,'cancelled',JSON.stringify(result));
assert.equal(result.render.state,'cancelled');
await assert.rejects(access(output));
console.log(JSON.stringify({checks:['native Escape cancellation observed','job cancelled not succeeded','no stale image published'],id:job.id}));
