import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, VERSION } from '../plugins/blender-bridge/skills/blender-bridge/scripts/blender-bridge.mjs';

const cli = fileURLToPath(new URL('../plugins/blender-bridge/skills/blender-bridge/scripts/blender-bridge.mjs', import.meta.url));
// Every CLI run writes its journal to a private temporary file, never the user's home.
const journalDir = await mkdtemp(path.join(tmpdir(), 'blender-cli-test-'));
after(() => rm(journalDir, { recursive: true, force: true }));
let journalCount = 0;
const freshJournal = () => path.join(journalDir, `jobs-${++journalCount}.jsonl`);
const json = async relative => JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8'));

function run(args, { input = '', env, journal = freshJournal() } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, BLENDER_BRIDGE_URL: '', BLENDER_BRIDGE_JOURNAL: journal, NODE_NO_WARNINGS: '1', ...env } });
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
  assert.match(result.stderr, /No running Blender .* for PID 2147483647/);
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
    if (req.url === '/api/health') return [200, { pid: 7, session: 's' }];
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

test('exec records the job with its session; recent and status find it without a target', async t => {
  let session = 'session-1';
  const url = await fakeBlender(t, req => {
    if (req.url === '/api/health') return [200, { pid: 42, session }];
    if (req.method === 'POST') return [202, { id: 'kept', status: 'queued' }];
    return [200, { id: 'kept', status: 'succeeded', result: 'r'.repeat(400), logs: ['x'.repeat(300), 'y'.repeat(300)] }];
  });
  const journal = freshJournal();
  const submitted = await run(['exec', '--file', '-', '--url', url, '--id', 'kept', '--no-wait'], { input: 'cube = 1\nreturn cube', journal });
  assert.equal(submitted.code, 0, submitted.stderr);
  const recent = JSON.parse((await run(['recent'], { journal })).stdout);
  assert.equal(recent.jobs[0].id, 'kept');
  assert.equal(recent.jobs[0].state, 'queued');
  assert.equal(recent.jobs[0].session, 'session-1');
  assert.equal(recent.jobs[0].pid, 42);
  assert.equal(recent.jobs[0].summary, 'cube = 1');
  assert.deepEqual(JSON.parse((await run(['recent', '--pid', '7'], { journal })).stdout).jobs, []);

  // No --url/--pid: the recorded endpoint is used, and --max-chars bounds what is printed.
  const status = await run(['status', 'kept', '--max-chars', '200'], { journal });
  assert.equal(status.code, 0, status.stderr);
  const shown = JSON.parse(status.stdout);
  assert.equal(shown.truncated.result, 400);
  assert.deepEqual(shown.logs, ['…[1 earlier lines omitted]', `…${'y'.repeat(200)}`]);
  assert.equal(JSON.parse((await run(['recent'], { journal })).stdout).jobs[0].state, 'succeeded');

  // A restarted Blender has a new session: its in-memory records are gone, so the outcome is unknown.
  session = 'session-2';
  const restarted = await run(['wait', 'kept'], { journal });
  assert.equal(restarted.code, 2);
  assert.match(restarted.stderr, /not the session job kept was recorded in/);
});

test('a failed query does not overwrite the recorded state', async t => {
  const url = await fakeBlender(t, req => {
    if (req.url === '/api/health') return [200, { pid: 1, session: 's' }];
    if (req.method === 'POST' && req.url.endsWith('/cancel')) return [409, { error: 'cancel in Render UI' }];
    if (req.method === 'POST') return [202, { id: 'render-job', status: 'queued' }];
    return [200, { id: 'render-job', status: 'running' }];
  });
  const journal = freshJournal();
  await run(['render', '--url', url, '--id', 'render-job', '--no-wait'], { journal });
  await run(['status', 'render-job'], { journal });
  assert.equal((await run(['cancel', 'render-job'], { journal })).code, 1);
  const [job] = JSON.parse((await run(['recent'], { journal })).stdout).jobs;
  assert.equal(job.state, 'running');
  assert.equal(job.operation, 'render');
});

test('an unwritable journal only warns; the job still runs', async t => {
  const url = await fakeBlender(t, req => req.url === '/api/health' ? [200, { pid: 1, session: 's' }]
    : req.method === 'POST' ? [202, { id: 'nj', status: 'queued' }] : [200, { id: 'nj', status: 'succeeded', result: 'ok' }]);
  const blocker = freshJournal();
  await writeFile(blocker, 'a file');
  const result = await run(['exec', '--file', '-', '--url', url, '--id', 'nj'], { input: 'return 1', journal: path.join(blocker, 'jobs.jsonl') });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /could not be updated/);
  assert.equal(JSON.parse(result.stdout).status, 'succeeded');
});

test('the recorded session is checked for every implicit target; an explicit other target only warns', async t => {
  let session = 's1';
  const url = await fakeBlender(t, (req, body) => req.url === '/api/health' ? [200, { pid: 3, session }]
    : req.method === 'POST' ? [202, { id: body.id, status: 'queued' }] : [200, { id: 'job', status: 'running' }]);
  const journal = freshJournal();
  assert.equal((await run(['exec', '--file', '-', '--url', url, '--id', 'job', '--no-wait'], { input: 'return 1', journal })).code, 0);
  session = 's2';
  // BLENDER_BRIDGE_URL is implicit: the restarted session is refused before anything is sent.
  const implicit = await run(['cancel', 'job'], { journal, env: { BLENDER_BRIDGE_URL: url } });
  assert.equal(implicit.code, 2);
  assert.match(implicit.stderr, /recorded s1, now s2/);
  // An explicit target is the caller's choice: answer with a warning, and keep the recorded state.
  const chosen = await run(['status', 'job', '--url', url], { journal });
  assert.equal(chosen.code, 0, chosen.stderr);
  assert.match(chosen.stderr, /not the recorded job/);
  const [job] = JSON.parse((await run(['recent'], { journal })).stdout).jobs;
  assert.deepEqual([job.session, job.state], ['s1', 'queued']);
});

test('reusing a recorded ID that Blender refuses keeps the original record', async t => {
  const url = await fakeBlender(t, (req, body) => req.url === '/api/health' ? [200, { pid: 3, session: 's' }]
    : req.method === 'POST' ? (body.code === 'return 1' ? [202, { id: body.id, status: 'queued' }] : [409, { error: 'different payload' }])
    : [200, { id: 'reused', status: 'succeeded' }]);
  const journal = freshJournal();
  assert.equal((await run(['exec', '--file', '-', '--url', url, '--id', 'reused'], { input: 'return 1', journal })).code, 0);
  const conflict = await run(['exec', '--file', '-', '--url', url, '--id', 'reused'], { input: 'return 2', journal });
  assert.equal(conflict.code, 1);
  const [job] = JSON.parse((await run(['recent'], { journal })).stdout).jobs;
  assert.deepEqual([job.summary, job.state], ['return 1', 'succeeded']);
});

test('an unreadable journal asks for a target; recent degrades to a warning; "off" records nothing', async t => {
  const unreadable = freshJournal();
  await mkdir(unreadable); // a directory where the journal file should be
  const status = await run(['status', 'some-job'], { journal: unreadable });
  assert.equal(status.code, 1);
  assert.match(status.stderr, /could not be read.*Pass --pid or --url/);
  const recent = await run(['recent'], { journal: unreadable });
  assert.equal(recent.code, 0);
  assert.deepEqual(JSON.parse(recent.stdout).jobs, []);
  assert.match(recent.stderr, /could not be read/);

  const url = await fakeBlender(t, (req, body) => req.url === '/api/health' ? [200, { pid: 3, session: 's' }]
    : req.method === 'POST' ? [202, { id: body.id, status: 'queued' }] : [200, { id: 'quiet', status: 'failed', error: 'E'.repeat(5000) }]);
  const quiet = await run(['exec', '--file', '-', '--url', url, '--id', 'quiet', '--max-chars', '200'], { input: 'return 1', env: { BLENDER_BRIDGE_JOURNAL: 'off' } });
  assert.equal(quiet.code, 1);
  assert.equal(JSON.parse(quiet.stdout).truncated.error, 5000);
  assert.doesNotMatch(quiet.stderr, /warning/);
  assert.deepEqual(JSON.parse((await run(['recent'], { env: { BLENDER_BRIDGE_JOURNAL: 'off' } })).stdout).jobs, []);
});

test('--max-chars also bounds a long error message', async t => {
  const url = await fakeBlender(t, req => req.url === '/api/health' ? [200, { pid: 3, session: 's' }] : [400, { error: 'x'.repeat(5000) }]);
  const result = await run(['exec', '--file', '-', '--url', url, '--max-chars', '200'], { input: 'return 1' });
  assert.equal(result.code, 1);
  assert.ok(result.stderr.length < 1000, String(result.stderr.length));
  assert.match(result.stderr, /truncated 4800 chars/);
});
