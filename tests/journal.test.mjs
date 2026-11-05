import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Journal, summarize, budget } from '../plugins/blender-bridge/skills/blender-bridge/scripts/journal.mjs';

async function scratch(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'bridge-journal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('jobs merge per ID, keep the submission time and list newest first', async t => {
  const journal = new Journal(path.join(await scratch(t), 'nested', 'jobs.jsonl'));
  await journal.append({ event: 'submitted', id: 'a', operation: 'eval', state: 'unknown', url: 'http://127.0.0.1:1', summary: 'first' });
  await new Promise(done => setTimeout(done, 5));
  await journal.append({ event: 'submitted', id: 'b', operation: 'eval', state: 'unknown', url: 'http://127.0.0.1:2' });
  await journal.append({ event: 'state', id: 'a', state: 'succeeded', url: 'http://127.0.0.1:1' });
  const jobs = await journal.jobs();
  assert.deepEqual(jobs.map(job => job.id), ['b', 'a']);
  assert.equal(jobs[1].state, 'succeeded');
  assert.equal(jobs[1].summary, 'first');
  assert.equal(jobs[1].url, 'http://127.0.0.1:1');
  assert.ok(jobs[1].updatedAt >= jobs[1].submittedAt);
  assert.equal((await journal.find('a')).state, 'succeeded');
  assert.equal(await journal.find('missing'), undefined);
});

test('a reused ID in another session, project or endpoint stays a separate job', async t => {
  const journal = new Journal(path.join(await scratch(t), 'jobs.jsonl'));
  await journal.append({ event: 'submitted', id: 'same', session: 's1', url: 'http://127.0.0.1:1', summary: 'old session' });
  await journal.append({ event: 'submitted', id: 'same', projectPath: 'D:\\A', url: 'http://127.0.0.1:2' });
  await journal.append({ event: 'submitted', id: 'same', projectPath: 'd:\\a', url: 'http://127.0.0.1:3', summary: 'same project, new port' });
  await new Promise(done => setTimeout(done, 5));
  await journal.append({ event: 'submitted', id: 'same', session: 's2', url: 'http://127.0.0.1:1', summary: 'new session' });
  await journal.append({ event: 'state', id: 'same', session: 's1', state: 'succeeded' });
  const jobs = await journal.jobs();
  assert.equal(jobs.length, 3);
  assert.equal(jobs.find(job => job.session === 's1').state, 'succeeded');
  assert.equal(jobs.find(job => job.session === 's2').state, undefined);
  assert.equal(jobs.find(job => job.projectPath).summary, 'same project, new port');
  assert.equal((await journal.find('same')).summary, 'new session');
});

test('a missing journal is empty and corrupt lines are skipped', async t => {
  const dir = await scratch(t);
  assert.deepEqual(await new Journal(path.join(dir, 'none.jsonl')).jobs(), []);
  const file = path.join(dir, 'jobs.jsonl');
  await writeFile(file, 'not json\n{"id":"ok","at":"2026-01-01T00:00:00Z","event":"submitted"}\n{"no":"id"}\n\n');
  assert.deepEqual((await new Journal(file).jobs()).map(job => job.id), ['ok']);
});

test('an unwritable journal warns instead of throwing', async t => {
  const dir = await scratch(t);
  await writeFile(path.join(dir, 'blocker'), 'a file, not a directory');
  const warning = await new Journal(path.join(dir, 'blocker', 'jobs.jsonl')).note({ id: 'x' });
  assert.match(warning, /could not be updated.*printed job ID/);
});

test('the journal is trimmed to its newest lines once it grows past 1 MiB', async t => {
  const file = path.join(await scratch(t), 'jobs.jsonl');
  // 2500 jobs, each submitted with its endpoint and later updated with a long state line.
  const lines = [];
  for (let i = 0; i < 2500; i++) {
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    lines.push(JSON.stringify({ at, event: 'submitted', id: `job-${i}`, url: `http://127.0.0.1:${1000 + i}`, session: `s${i}`, summary: 'x'.repeat(300) }));
    lines.push(JSON.stringify({ at, event: 'state', id: `job-${i}`, session: `s${i}`, state: 'succeeded' }));
  }
  await writeFile(file, `${lines.join('\n')}\n`);
  const journal = new Journal(file);
  await journal.append({ event: 'submitted', id: 'newest', session: 'now', url: 'http://127.0.0.1:9' });
  assert.ok((await stat(file)).size <= 512 * 1024);
  const kept = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(kept.length > 500 && kept.length <= 2000, String(kept.length));
  assert.ok(kept.every(entry => entry.event === 'snapshot'));
  assert.equal(kept.at(-1).id, 'newest');
  // Compaction keeps each job whole: endpoint and session survive with the final state.
  const oldest = (await journal.jobs()).at(-1);
  assert.ok(oldest.url && oldest.session && oldest.summary && oldest.state === 'succeeded', JSON.stringify(oldest));
  assert.equal(oldest.submittedAt, new Date(Date.UTC(2026, 0, 1, 0, 0, Number(oldest.id.slice(4)))).toISOString());
});

test('summaries keep the first non-empty line, shortened', () => {
  assert.equal(summarize('\n  \n  return 42;\nmore'), 'return 42;');
  assert.equal(summarize('x'.repeat(200)).length, 80);
  assert.equal(summarize(undefined), '');
});

test('budget shortens text heads and keeps the newest log lines', () => {
  const job = { id: 'j', result: 'r'.repeat(500), error: '', logs: ['a'.repeat(150), 'b'.repeat(150), 'c'.repeat(150)] };
  const short = budget(job, 300);
  assert.equal(short.result.length, 300 + '…[truncated 200 chars]'.length);
  assert.deepEqual(short.logs, ['…[1 earlier lines omitted]', 'b'.repeat(150), 'c'.repeat(150)]);
  assert.deepEqual(short.truncated, { result: 500, logs: 3 });
  assert.match(short.hint, /without it/);
  assert.equal(job.result.length, 500, 'the original job is not modified');
  assert.equal(budget(job, 0), job);
  assert.equal(budget({ id: 'small', result: 'ok', logs: ['x'] }, 300).truncated, undefined);
});

test('concurrent appends across a compaction lose nothing', async t => {
  const file = path.join(await scratch(t), 'jobs.jsonl');
  // Start just under the compaction threshold so the burst below triggers it.
  const lines = [];
  for (let i = 0; lines.join('\n').length < 1024 * 1024 - 4000; i++)
    lines.push(JSON.stringify({ at: new Date(Date.UTC(2026, 0, 1, 0, 0, i % 60, i % 1000)).toISOString(), event: 'submitted', id: `old-${i}`, session: `s${i}`, summary: 'x'.repeat(200) }));
  await writeFile(file, `${lines.join('\n')}\n`);
  const writers = Array.from({ length: 30 }, (_, i) => new Journal(file).append({ event: 'submitted', id: `burst-${i}`, session: 'now' }));
  assert.deepEqual(await Promise.all(writers), Array(30).fill(''));
  const ids = new Set((await new Journal(file).jobs()).map(job => job.id));
  for (let i = 0; i < 30; i++) assert.ok(ids.has(`burst-${i}`), `burst-${i} was lost`);
  assert.ok((await stat(file)).size < 1024 * 1024);
});

test('a stale lock left by a killed process is taken over; a live one makes note() warn', async t => {
  const dir = await scratch(t);
  const file = path.join(dir, 'jobs.jsonl');
  await writeFile(`${file}.lock`, '');
  const old = new Date(Date.now() - 60_000);
  await utimes(`${file}.lock`, old, old);
  assert.equal(await new Journal(file).append({ id: 'after-stale' }), '');
  assert.equal((await new Journal(file).find('after-stale')).id, 'after-stale');
  await writeFile(`${file}.lock`, '');
  const started = Date.now();
  assert.match(await new Journal(file).note({ id: 'blocked' }), /locked by another process/);
  assert.ok(Date.now() - started >= 9000);
});

test('"off" disables the journal entirely', async () => {
  const previous = process.env.BRIDGE_TEST_JOURNAL;
  process.env.BRIDGE_TEST_JOURNAL = 'off';
  try {
    const journal = Journal.forTool('bridge-test', 'BRIDGE_TEST_JOURNAL');
    assert.equal(journal.file, null);
    assert.equal(await journal.note({ id: 'x' }), '');
    assert.deepEqual(await journal.jobs(), []);
  } finally { if (previous === undefined) delete process.env.BRIDGE_TEST_JOURNAL; else process.env.BRIDGE_TEST_JOURNAL = previous; }
});
