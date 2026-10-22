#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

export const terminal = new Set(['succeeded', 'failed', 'cancelled', 'expired', 'interrupted']);

export async function request(base, path, options = {}) {
  const url = new URL(base);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:')
    throw new Error('Bridge endpoint must be local HTTP');
  const { body, signal, ...rest } = options;
  const response = await fetch(new URL(path, url), {
    ...rest, headers: { 'content-type': 'application/json', ...rest.headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status });
  return data;
}

export async function discover() {
  const directory = join(tmpdir(), 'blender-bridge');
  const files = await readdir(directory).catch(() => []);
  const results = await Promise.all(files.filter(name => /^\d+\.json$/.test(name)).map(async name => {
    try {
      const info = JSON.parse(await readFile(join(directory, name), 'utf8'));
      const health = await request(info.url, '/api/health', { signal: AbortSignal.timeout(1000) });
      return health.pid === info.pid && health.session === info.session ? health : null;
    } catch { return null; }
  }));
  return results.filter(Boolean);
}

export function submit(base, code, { id = randomUUID(), interval = 0.2, ttl = 30, signal } = {}) {
  return request(base, '/api/jobs', { method: 'POST', body: { id, code, interval, ttl }, signal });
}

export function screenshotCode(output) {
  if (typeof output !== 'string' || !isAbsolute(output) || extname(output).toLowerCase() !== '.png')
    throw new Error('Screenshot output must be an absolute .png path');
  return `from blender_bridge.screenshot import capture\nreturn (yield from capture(${JSON.stringify(output)}))`;
}

export function submitScreenshot(base, output, options) {
  return submit(base, screenshotCode(output), options);
}

export async function wait(base, id, { timeout = 60, signal, onProgress } = {}) {
  const deadline = Date.now() + timeout * 1000;
  while (true) {
    signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Object.assign(new Error(`Wait expired; job ${id} may still run. Query status; do not resubmit.`), { id, unknown: true });
    const budget = AbortSignal.timeout(Math.max(1, Math.min(5000, remaining)));
    let current;
    try {
      current = await request(base, `/api/jobs/${encodeURIComponent(id)}`, { signal: signal ? AbortSignal.any([signal, budget]) : budget });
    } catch (error) {
      throw Object.assign(new Error(`Cannot resolve job ${id}: ${error.message}. Inspect status/session and scene; do not resubmit.`), { id, unknown: true, status: error.status, cause: error });
    }
    onProgress?.(current);
    if (terminal.has(current.status)) return current;
    await new Promise(done => setTimeout(done, Math.min(150, remaining)));
  }
}

async function main(argv) {
  const [command, ...args] = argv;
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      opts[key] = ['no-wait'].includes(key) ? true : args[++i];
    } else positional.push(args[i]);
  }
  if (!command || command === 'help') {
    console.log('Blender Bridge: list | health | exec --file script.py [--id ID --interval 0.2 --ttl 30 --timeout 60 --no-wait] | status ID | wait ID | cancel ID | screenshot --output new.png. Target with --url URL or --pid PID.');
    return;
  }
  if (command === 'list') { console.log(JSON.stringify(await discover(), null, 2)); return; }
  let base = opts.url || process.env.BLENDER_BRIDGE_URL;
  if (!base) {
    const instances = (await discover()).filter(item => !opts.pid || item.pid === Number(opts.pid));
    if (instances.length !== 1) throw new Error(`Expected one Blender; found ${instances.length}. Use list and --pid/--url.`);
    base = instances[0].url;
  }
  let result;
  if (command === 'health') result = await request(base, '/api/health');
  else if (['status', 'wait', 'cancel'].includes(command)) {
    if (!positional[0]) throw new Error('Job ID required');
    result = command === 'wait' ? await wait(base, positional[0], { timeout: Number(opts.timeout || 60) })
      : await request(base, `/api/jobs/${encodeURIComponent(positional[0])}${command === 'cancel' ? '/cancel' : ''}`,
          command === 'cancel' ? { method: 'POST', body: {} } : {});
  } else if (command === 'exec' || command === 'screenshot') {
    let code;
    if (command === 'screenshot') {
      if (!opts.output) throw new Error('--output is required');
      code = screenshotCode(resolve(opts.output));
    } else {
      if (!opts.file) throw new Error('--file is required');
      code = await readFile(opts.file, 'utf8');
    }
    const id = opts.id || randomUUID();
    console.error(JSON.stringify({ id, url: base, note: 'Timeout is not cancellation; query this ID before retrying.' }));
    try {
      result = await submit(base, code, { id, interval: Number(opts.interval || 0.2), ttl: Number(opts.ttl || 30) });
    } catch (error) {
      if (!error.status) throw Object.assign(new Error(`Submission outcome unknown for ${id}: ${error.message}. Query this ID and inspect the scene; do not resubmit.`), { unknown: true });
      throw error;
    }
    if (!opts['no-wait']) result = await wait(base, id, { timeout: Number(opts.timeout || 60) });
  } else throw new Error(`Unknown command: ${command}`);
  console.log(JSON.stringify(result, null, 2));
  if (result.status && terminal.has(result.status) && result.status !== 'succeeded') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = error.unknown ? 2 : 1; });
}
