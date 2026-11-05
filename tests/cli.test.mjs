import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, VERSION } from '../plugins/blender-bridge/skills/blender-bridge/scripts/blender-bridge.mjs';

const cli = fileURLToPath(new URL('../plugins/blender-bridge/skills/blender-bridge/scripts/blender-bridge.mjs', import.meta.url));
const json = async relative => JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8'));

function run(args, { input = '', env } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, BLENDER_BRIDGE_URL: '', ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', fail);
    child.on('close', code => done({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('every release manifest carries the CLI version', async () => {
  assert.equal((await json('../package.json')).version, VERSION);
  assert.equal((await json('../plugins/blender-bridge/plugin.json')).version, VERSION);
  assert.equal((await json('../plugins/blender-bridge/.claude-plugin/plugin.json')).version, VERSION);
});

test('options are validated per command instead of being ignored', () => {
  assert.deepEqual(parseArgs('exec', ['--file', 'a.py']).opts, { file: 'a.py', interval: 0.2, ttl: 30, timeout: 60 });
  assert.equal(parseArgs('wait', ['job-1', '--pid', '42', '--timeout', '600']).opts.pid, 42);
  assert.equal(parseArgs('exec', ['--file', '-']).opts.file, '-');
  assert.ok(parseArgs('render', ['--help']).opts.help);
  for (const [command, args, message] of [
    ['exec', ['--timeout', 'abc', '--file', 'a.py'], /--timeout/],
    ['exec', ['--file'], /needs a value/],
    ['exec', ['--file', '--no-wait'], /needs a value/],
    ['exec', [], /requires --file/],
    ['exec', ['--file', 'a', '--file', 'b'], /Duplicate/],
    ['exec', ['--file', 'a', '--interval', '0'], /--interval/],
    ['exec', ['--file', 'a', '--ttl', '4000'], /--ttl/],
    ['exec', ['--file', 'a', '--id', 'bad id'], /Invalid job ID/],
    ['health', ['--project', 'x'], /not valid for health/],
    ['health', ['--pid', '1.5'], /integer/],
    ['health', ['--pid', '1', '--url', 'http://127.0.0.1:1'], /either/],
    ['status', [], /exactly one job ID/],
    ['status', ['a', 'b'], /exactly one job ID/],
    ['wait', ['job', '--no-wait'], /not valid for wait/],
    ['screenshot', [], /requires --output/],
    ['list', ['extra'], /Unexpected argument/],
    ['frobnicate', [], /Unknown command/],
  ]) assert.throws(() => parseArgs(command, args), message, `${command} ${args.join(' ')}`);
});

test('exec --file - submits the UTF-8 script read from standard input', async t => {
  const posted = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST') { posted.push(JSON.parse(raw)); res.writeHead(202); res.end(JSON.stringify({ id: posted.at(-1).id, status: 'queued' })); }
    else res.end(JSON.stringify({ id: 'stdin-job', status: 'succeeded', result: 'ok' }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const script = "name = '立方体'\nyield 'step'\nreturn name\n";
  const result = await run(['exec', '--file', '-', '--url', url, '--id', 'stdin-job'], { input: '﻿' + script });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].code, script);
  assert.equal(JSON.parse(result.stdout).status, 'succeeded');
});

test('--pid selects by discovery even when BLENDER_BRIDGE_URL is set', async () => {
  // No live instance has this PID, so the environment URL must not be used instead.
  const result = await run(['health', '--pid', '2147483647'], { env: { BLENDER_BRIDGE_URL: 'http://127.0.0.1:9' } });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Expected one Blender; found 0/);
});

async function fakeBlender(t, handler) {
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const [status, body, headers] = handler(req, raw && JSON.parse(raw));
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('--version prints without contacting Blender; empty values are rejected', async () => {
  const result = await run(['--version']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), VERSION);
  assert.throws(() => parseArgs('health', ['--url', '']), /needs a value/);
  assert.throws(() => parseArgs('health', ['--url', '  ']), /needs a value/);
});

test('fractional wait budgets do not crash after a job was submitted', async t => {
  let polls = 0;
  const url = await fakeBlender(t, req => req.method === 'POST'
    ? [202, { id: 'frac', status: 'queued' }]
    : [200, { id: 'frac', status: ++polls < 3 ? 'running' : 'succeeded' }]);
  const result = await run(['exec', '--file', '-', '--url', url, '--id', 'frac', '--timeout', '1.0001'], { input: 'return 1' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'succeeded');
});

test('a reply for a different or malformed job is unknown, never success', async t => {
  const url = await fakeBlender(t, req => req.url.endsWith('/empty') ? [200, {}] : [200, { id: 'other', status: 'succeeded' }]);
  for (const args of [['wait', 'expected'], ['status', 'expected'], ['status', 'empty']]) {
    const result = await run([...args, '--url', url]);
    assert.equal(result.code, 2, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /invalid or mismatched/);
  }
});

test('HTTP answers are classified by what they prove about execution', async t => {
  const url = await fakeBlender(t, (req, body) => {
    if (req.url === '/api/jobs/gone') return [404, { error: 'unknown job' }];
    if (req.url === '/api/jobs/busy/cancel') return [409, { error: 'cancel in Render UI' }];
    if (body?.id === 'conflict') return [409, { error: 'different payload' }];
    if (body?.id === 'crash') return [500, { error: 'internal' }];
    if (body?.id === 'full') return [503, { error: 'capacity' }];
    return [404, { error: 'not found' }];
  });
  const cases = [
    [['status', 'gone'], 2, /cannot be determined/],
    [['cancel', 'busy'], 1, /Render UI/],
    [['exec', '--file', '-', '--id', 'conflict'], 1, /different payload/],
    [['exec', '--file', '-', '--id', 'full'], 1, /capacity/],
    [['exec', '--file', '-', '--id', 'crash'], 2, /outcome unknown/],
  ];
  for (const [args, code, message] of cases) {
    const result = await run([...args, '--url', url], { input: 'return 1' });
    assert.equal(result.code, code, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, message);
  }
});

test('requests never follow redirects or leave the selected endpoint', async t => {
  let reached = 0;
  const other = await fakeBlender(t, () => { reached++; return [202, { id: 'r', status: 'queued' }]; });
  const url = await fakeBlender(t, () => [307, {}, { location: `${other}/api/jobs` }]);
  const { request, submit } = await import('../plugins/blender-bridge/skills/blender-bridge/scripts/blender-bridge.mjs');
  await assert.rejects(submit(url, 'return 1', { id: 'r' }));
  assert.equal(reached, 0);
  await assert.rejects(request(url, `${other}/api/health`), /stay on the selected endpoint/);
  await assert.rejects(request(url, '//example.com/api/health'), /stay on the selected endpoint/);
});

test('a status query that cannot reach Blender exits as unknown, not failed', async () => {
  const result = await run(['status', 'job-1', '--url', 'http://127.0.0.1:9']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /outcome is unknown/);
});

test('a bad endpoint is rejected before a job ID is issued', async () => {
  for (const url of ['http://example.com:6418', 'not a url', 'https://127.0.0.1:6418']) {
    const result = await run(['exec', '--file', '-', '--url', url], { input: 'return 1' });
    assert.equal(result.code, 1, `${url}: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /"id"/);
    assert.match(result.stderr, /Bridge endpoint/);
  }
});

test('both marketplaces list the plugin under its manifest name', async () => {
  const name = (await json('../plugins/blender-bridge/.claude-plugin/plugin.json')).name;
  assert.equal((await json('../plugins/blender-bridge/plugin.json')).name, name);
  for (const catalog of ['../.claude-plugin/marketplace.json', '../.agents/plugins/marketplace.json'])
    assert.ok((await json(catalog)).plugins.some(entry => entry.name === name), catalog);
});

test('DSH wait reports an invalid poll as unknown, not as an expired budget', async t => {
  let polls = 0;
  const url = await fakeBlender(t, req => req.method === 'POST'
    ? [202, { id: 'dsh-job', status: 'queued' }]
    : [200, ++polls < 2 ? { id: 'dsh-job', status: 'running' } : { id: 'someone-else', status: 'succeeded' }]);
  const { createTools } = await import('../adapters/dsh/index.mjs');
  const tool = createTools().find(item => item.name === 'blender_execute');
  const value = await tool.execute({ code: 'return 1', id: 'dsh-job', base: url, timeoutSeconds: 10 }, {});
  assert.equal(value.outcome, 'unknown', JSON.stringify(value));
  assert.match(value.error, /invalid or mismatched/);
});

test('the shared wait rejects a non-numeric budget before polling', async () => {
  const { wait } = await import('../plugins/blender-bridge/skills/blender-bridge/scripts/blender-bridge.mjs');
  await assert.rejects(wait('http://127.0.0.1:9', 'x', { timeout: Number('abc') }), /non-negative number/);
});
