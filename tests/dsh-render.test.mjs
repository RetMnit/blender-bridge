import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTools } from '../adapters/dsh/index.mjs';

test('DSH render submits once, preserves render state and reuses job endpoint',async()=>{
  const writes=[];
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;
    res.setHeader('content-type','application/json');
    if(req.method==='POST'){
      const body=JSON.parse(raw);writes.push(body);res.end(JSON.stringify({id:body.id,status:'queued'}));
    }else res.end(JSON.stringify({id:'render-id',status:'running',render:{state:'running',elapsed_seconds:2.5},progress:'Rendering Scene',steps:3}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    const tool=createTools().find(t=>t.name==='blender_bridge');
    assert(tool.parameters.properties.action.enum.includes('render'));
    const queued=await tool.execute({action:'render',id:'render-id',base:`http://127.0.0.1:${server.address().port}`,wait:false},{});
    assert.equal(queued.outcome,'pending');
    assert.match(writes[0].code,/yield from render_still/);
    const current=await tool.execute({action:'status',id:'render-id'},{});
    assert.equal(current.renderState,'running');assert.equal(current.renderElapsedSeconds,2.5);
    assert.equal(writes.length,1);
    const bad=await tool.execute({action:'render',output:'relative.png'},{});
    assert.equal(bad.outcome,'not-submitted');assert.equal(writes.length,1);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
