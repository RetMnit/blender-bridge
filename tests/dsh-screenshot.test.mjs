// DSH adapter screenshot action — isolated mock protocol tests (no Blender).
//
// Run: node --test tests/dsh-screenshot.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.BLENDER_BRIDGE_URL = '';
const adapter = await import('../adapters/dsh/index.mjs');

function makeServer({ mode = 'success', pid = 44001, session = 'dsh-shot-test' } = {}) {
  const state = { requests: [], jobs: new Map(), url: '', mode };
  const terminal = new Set(['succeeded', 'failed', 'cancelled', 'expired', 'interrupted']);
  const snapshot = (job) => ({
    id: job.id,
    status: job.status,
    created: Date.now() / 1000,
    logs: job.logs,
    result: job.result,
    error: job.error,
    progress: job.progress,
    steps: job.steps,
  });
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : undefined;
      const url = new URL(req.url, 'http://127.0.0.1');
      state.requests.push({ method: req.method, path: url.pathname, body });
      const send = (status, data) => {
        const text = JSON.stringify(data);
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
        res.end(text);
      };
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return send(200, {
          ok: true, bridge: '0.3.0', protocol: 2, blender: '5.2.0 LTS', python: '3.13.13',
          pid, session, file: '', background: false, url: state.url,
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/jobs') {
        if (mode === 'drop') {
          req.socket.destroy();
          return;
        }
        const job = {
          id: body.id,
          status: 'queued',
          logs: [],
          result: '',
          error: '',
          progress: '',
          steps: 0,
          ticks: 0,
          requestedCode: body.code,
        };
        state.jobs.set(job.id, job);
        return send(202, snapshot(job));
      }
      const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (req.method === 'GET' && jobMatch) {
        const job = state.jobs.get(decodeURIComponent(jobMatch[1]));
        if (!job) return send(404, { error: 'unknown/evicted job; inspect scene before retry' });
        job.ticks += 1;
        if (job.status === 'queued') {
          job.status = 'running';
          job.progress = 'Preparing Blender window for screenshot';
          job.steps = 1;
        }
        if (job.status === 'running' && mode === 'success' && job.ticks >= 2) {
          const match = /capture\((".*")\)/.exec(job.requestedCode ?? '');
          let output = '';
          try {
            output = match ? JSON.parse(match[1]) : '';
          } catch {
            output = '';
          }
          job.status = 'succeeded';
          job.steps = 2;
          job.result = JSON.stringify({
            path: output,
            width: 1920,
            height: 1080,
            restored_minimized: true,
            validated: true,
          });
        }
        return send(200, snapshot(job));
      }
      const cancelMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && cancelMatch) {
        const job = state.jobs.get(decodeURIComponent(cancelMatch[1]));
        if (!job) return send(404, { error: 'unknown job' });
        if (!terminal.has(job.status)) job.status = 'cancelled';
        return send(200, snapshot(job));
      }
      return send(404, { error: 'not found' });
    });
  });
  state.server = server;
  return state;
}

async function startServer(options) {
  const state = makeServer(options);
  await new Promise((resolve) => state.server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${state.server.address().port}`;
  return state;
}

async function stopServer(state) {
  if (!state) return;
  state.server.closeAllConnections();
  await new Promise((resolve) => state.server.close(resolve));
}

const jobPosts = (state) => state.requests.filter((r) => r.method === 'POST' && r.path === '/api/jobs');
const cancelPosts = (state) => state.requests.filter((r) => r.method === 'POST' && /\/cancel$/.test(r.path));

test('screenshot is exposed with output/id/wait/timeout/interval parameters', () => {
  const [, bridge] = adapter.createTools({});
  const props = bridge.parameters.properties;
  for (const key of ['output', 'id', 'wait', 'timeoutSeconds', 'queueTimeoutSeconds', 'intervalSeconds', 'base']) {
    assert.ok(props[key], `missing bridge parameter ${key}`);
  }
  assert.ok(props.action.enum.includes('screenshot'), 'screenshot must be an allowed action');
  assert.match(bridge.description, /0\.3\.0/, 'description must mention the required add-on version');
  assert.match(bridge.description, /minimized/i, 'description must explain Windows minimized restore');
  assert.match(bridge.description, /black/i, 'description must explain black-frame failure');
  assert.match(props.output.description, /\.png/);
});

test('missing or invalid output path is rejected before any submission', async () => {
  const server = await startServer();
  try {
    const [, bridge] = adapter.createTools({ base: server.url });
    for (const args of [
      { action: 'screenshot' },
      { action: 'screenshot', output: '' },
      { action: 'screenshot', output: 'relative/shot.png' },
      { action: 'screenshot', output: join(tmpdir(), 'shot.jpg') },
    ]) {
      const value = await bridge.execute(args, {});
      assert.equal(value.ok, false, `expected rejection for ${JSON.stringify(args)}`);
      assert.equal(value.outcome, 'not-submitted');
      assert.equal(value.executionMayHaveOccurred, false);
      assert.match(value.hint, /Nothing was submitted/);
    }
    assert.equal(jobPosts(server).length, 0, 'invalid path must not reach the bridge');
  } finally {
    await stopServer(server);
  }
});

test('screenshot delegates to the shared client code and keeps job/endpoint semantics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-screenshot-'));
  const output = join(dir, 'capture.png');
  const server = await startServer();
  try {
    const [, bridge] = adapter.createTools({ base: server.url });
    const value = await bridge.execute({ action: 'screenshot', output, intervalSeconds: 0.3, queueTimeoutSeconds: 45 }, {});
    assert.equal(value.ok, true);
    assert.equal(value.outcome, 'succeeded');
    assert.equal(value.url, server.url);
    assert.ok(value.id.length > 0);

    const post = jobPosts(server)[0];
    assert.ok(post, 'expected a job submission');
    assert.match(post.body.code, /from blender_bridge\.screenshot import capture/);
    assert.ok(post.body.code.includes(JSON.stringify(output)), 'code must embed the absolute output path');
    assert.equal(post.body.interval, 0.3);
    assert.equal(post.body.ttl, 45);
    assert.equal(post.body.id, value.id);

    const meta = JSON.parse(value.result);
    assert.equal(meta.path, output);
    assert.equal(meta.width, 1920);
    assert.equal(meta.validated, true);

    // The job ID → base mapping is shared with blender_execute.
    const status = await bridge.execute({ action: 'status', id: value.id }, {});
    assert.equal(status.ok, true);
    assert.equal(status.outcome, 'succeeded');
  } finally {
    await stopServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('screenshot supports wait:false and explicit IDs without changing the submission', async () => {
  const server = await startServer({ mode: 'slow' });
  try {
    const [, bridge] = adapter.createTools({ base: server.url });
    const value = await bridge.execute(
      { action: 'screenshot', output: join(tmpdir(), 'dsh-shot-pending.png'), id: 'shot-id-1', wait: false, intervalSeconds: 0.35 },
      {},
    );
    assert.equal(value.outcome, 'pending');
    assert.equal(value.id, 'shot-id-1');
    const post = jobPosts(server)[0];
    assert.equal(post.body.id, 'shot-id-1');
    assert.equal(post.body.interval, 0.35);
    assert.equal(cancelPosts(server).length, 0);
  } finally {
    await stopServer(server);
  }
});

test('screenshot wait timeout reports pending without cancelling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-screenshot-to-'));
  const server = await startServer({ mode: 'slow' });
  try {
    const [, bridge] = adapter.createTools({ base: server.url });
    const value = await bridge.execute({ action: 'screenshot', output: join(dir, 'slow.png'), timeoutSeconds: 1 }, {});
    assert.equal(value.ok, true);
    assert.equal(value.outcome, 'pending');
    assert.ok(value.id.length > 0);
    assert.ok(value.steps >= 1);
    assert.match(value.hint, /NOT cancelled/);
    assert.equal(cancelPosts(server).length, 0, 'wait timeout must never send cancel');
  } finally {
    await stopServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('lost screenshot submission response is reported as unknown, not rejected', async () => {
  const server = await startServer({ mode: 'drop' });
  try {
    const [, bridge] = adapter.createTools({ base: server.url });
    const value = await bridge.execute({ action: 'screenshot', output: join(tmpdir(), 'dsh-shot-dropped.png') }, {});
    assert.equal(value.ok, false);
    assert.equal(value.outcome, 'unknown');
    assert.ok(value.id.length > 0, 'lost submission keeps its job ID');
    assert.equal(value.executionMayHaveOccurred, true);
    assert.doesNotMatch(value.outcome, /rejected|not-submitted/);
  } finally {
    await stopServer(server);
  }
});

test('screenshot may auto-select the only discovered instance', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'dsh-shot-discovery-'));
  const discoveryDir = join(sandbox, 'blender-bridge');
  await mkdir(discoveryDir, { recursive: true });
  const server = await startServer({ pid: 44123, session: 'dsh-shot-discovery' });
  try {
    await writeFile(
      join(discoveryDir, '44123.json'),
      JSON.stringify({ pid: 44123, session: 'dsh-shot-discovery', url: server.url }),
      'utf8',
    );
    process.env.TEMP = sandbox;
    process.env.TMP = sandbox;
    const dir = await mkdtemp(join(sandbox, 'out-'));
    const [, bridge] = adapter.createTools({});
    const value = await bridge.execute({ action: 'screenshot', output: join(dir, 'discovered.png') }, {});
    assert.equal(value.ok, true);
    assert.equal(value.outcome, 'succeeded');
    assert.equal(value.url, server.url);
    assert.match(value.hint, /only discovered Blender instance/);
  } finally {
    await stopServer(server);
    await rm(sandbox, { recursive: true, force: true });
  }
});
