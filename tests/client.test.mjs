import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { request, submit, wait } from '../plugins/blender-bridge/skills/blender-bridge/scripts/blender-bridge.mjs';

test('client preserves IDs, errors, polls status without resubmitting', async () => {
  const received = [];
  let polls = 0;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    received.push([req.method, req.url, raw && JSON.parse(raw)]);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/jobs') { res.writeHead(202); res.end(JSON.stringify({ id: JSON.parse(raw).id, status: 'queued' })); }
    else if (req.url === '/api/jobs/abc') res.end(JSON.stringify({ id: 'abc', status: ++polls < 2 ? 'running' : 'succeeded' }));
    else { res.writeHead(409); res.end(JSON.stringify({ error: 'conflict' })); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await submit(base, 'return 7', { id: 'abc' })).id, 'abc');
    assert.equal((await wait(base, 'abc', { timeout: 3 })).status, 'succeeded');
    assert.equal(received.filter(([method]) => method === 'POST').length, 1);
    await assert.rejects(request(base, '/conflict'), /conflict/);
    await assert.rejects(wait(base, 'abc', { timeout: 0 }), /do not resubmit/);
    await assert.rejects(request('https://example.com', '/api/health'), /local HTTP/);
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
});
