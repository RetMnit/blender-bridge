#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

export const terminal = new Set(['succeeded', 'failed', 'cancelled', 'expired', 'interrupted']);
const states = new Set(['queued', 'running', ...terminal]);

/** A job reply must name the requested ID and a known status; anything else proves nothing about the job. */
export function checkJob(data, id) {
  if (!data || typeof data !== 'object' || data.id !== id || !states.has(data.status))
    throw Object.assign(new Error(`Blender returned an invalid or mismatched reply for job ${id}.`), { id, unknown: true, invalidResponse: true });
  return data;
}

/** Parse and check an endpoint; only loopback HTTP is accepted. */
export function localOrigin(base) {
  let url;
  try { url = new URL(base); } catch { throw new Error(`Bridge endpoint is not a valid URL: ${base}`); }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:')
    throw new Error('Bridge endpoint must be local HTTP');
  return url;
}

export async function request(base, path, options = {}) {
  const url = localOrigin(base);
  const target = new URL(path, url);
  if (target.origin !== url.origin) throw new Error('Bridge request path must stay on the selected endpoint');
  const { body, signal, ...rest } = options;
  // Never follow redirects: a redirected POST would carry the script to another endpoint.
  const response = await fetch(target, {
    ...rest, redirect: 'error', headers: { 'content-type': 'application/json', ...rest.headers },
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

export function renderCode(output, scene) {
  if (output !== undefined && (typeof output !== 'string' || !isAbsolute(output) || extname(output).toLowerCase() !== '.png'))
    throw new Error('Render output must be a new absolute .png path');
  if (scene !== undefined && (typeof scene !== 'string' || !scene.trim())) throw new Error('Render scene must be a nonempty name');
  return `from blender_bridge.render import render_still\nreturn (yield from render_still(output=${output === undefined ? 'None' : JSON.stringify(output)}, scene_name=${scene === undefined ? 'None' : JSON.stringify(scene)}))`;
}

export function submitRender(base, { output, scene, ...options } = {}) {
  return submit(base, renderCode(output, scene), options);
}

export async function wait(base, id, { timeout = 60, signal, onProgress } = {}) {
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 0) throw new Error('Wait timeout must be a non-negative number of seconds');
  const deadline = Date.now() + timeout * 1000;
  while (true) {
    signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Object.assign(new Error(`Wait expired; job ${id} may still run. Query status; do not resubmit.`), { id, unknown: true });
    const budget = AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(5000, remaining))));
    let current;
    try {
      current = await request(base, `/api/jobs/${encodeURIComponent(id)}`, { signal: signal ? AbortSignal.any([signal, budget]) : budget });
    } catch (error) {
      throw Object.assign(new Error(`Cannot resolve job ${id}: ${error.message}. Inspect status/session and scene; do not resubmit.`), { id, unknown: true, status: error.status, cause: error });
    }
    checkJob(current, id);
    onProgress?.(current);
    if (terminal.has(current.status)) return current;
    await new Promise(done => setTimeout(done, Math.min(150, remaining)));
  }
}

export const VERSION = '0.4.1';

const HELP = `Blender Bridge ${VERSION} (Node 22+, loopback only)
  blender-bridge list | --version
  blender-bridge health [target]
  blender-bridge exec --file <script.py | -> [target] [job options]
  blender-bridge screenshot --output <new absolute.png> [target] [job options]
  blender-bridge render [--output <new absolute.png>] [--scene <name>] [target] [job options]
  blender-bridge status|cancel <id> [target]
  blender-bridge wait <id> [target] [--timeout <s>]
Target:  --pid <PID> | --url <loopback URL>   (or BLENDER_BRIDGE_URL)
Job options:
  --id <id>          Stable job ID, 1..100 of A-Z a-z 0-9 _ - (otherwise generated)
  --interval <s>     Pause after each yield for redraw, 0.05..10 (default 0.2)
  --ttl <s>          Queue lifetime before execution starts, 1..3600 (default 30)
  --timeout <s>      Client wait budget, 1..3600 (default 60); not cancellation
  --no-wait          Submit and return the queued job immediately
--file - reads the script from standard input (UTF-8).
Exit codes: 0 succeeded/accepted, 1 failed/rejected, 2 outcome unknown (query the same ID; never resubmit).
Render succeeds only after completion; cancel a running native render in Blender's Render UI.`;

const TARGET = ['url', 'pid'];
const JOB = ['id', 'interval', 'ttl', 'timeout', 'no-wait'];
const COMMANDS = {
  list: { options: [] },
  health: { options: TARGET },
  status: { options: TARGET, id: true },
  cancel: { options: TARGET, id: true },
  wait: { options: [...TARGET, 'timeout'], id: true },
  exec: { options: [...TARGET, 'file', ...JOB], required: ['file'] },
  screenshot: { options: [...TARGET, 'output', ...JOB], required: ['output'] },
  render: { options: [...TARGET, 'output', 'scene', ...JOB] },
};
const FLAGS = new Set(['no-wait']);
const NUMBERS = { pid: [1, 2 ** 31, true], interval: [0.05, 10], ttl: [1, 3600], timeout: [1, 3600] };
const DEFAULTS = { interval: 0.2, ttl: 30, timeout: 60 };
const JOB_ID = /^[A-Za-z0-9_-]{1,100}$/;
const REJECTED = new Set([400, 401, 403, 404, 409, 413, 503]);

/** Strict CLI parsing: unknown, duplicate, missing or out-of-range options are errors, never ignored. */
export function parseArgs(command, args = []) {
  if (command === '--version' || command === 'version') return { opts: { version: true }, positional: [] };
  if (!command || command === 'help' || command === '--help' || args.includes('--help')) return { opts: { help: true }, positional: [] };
  const spec = COMMANDS[command];
  if (!spec) throw new Error(`Unknown command: ${command}. Use --help.`);
  const opts = {}, positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    if (!spec.options.includes(key)) throw new Error(`Option ${arg} is not valid for ${command}.`);
    if (Object.hasOwn(opts, key)) throw new Error(`Duplicate option ${arg}.`);
    if (FLAGS.has(key)) { opts[key] = true; continue; }
    const value = args[++i];
    if (value === undefined || value.startsWith('--') || !value.trim()) throw new Error(`Option ${arg} needs a value.`);
    opts[key] = value;
  }
  for (const key of spec.required || []) if (opts[key] === undefined) throw new Error(`${command} requires --${key}.`);
  if (positional.length !== (spec.id ? 1 : 0)) throw new Error(spec.id ? `${command} needs exactly one job ID.` : `Unexpected argument: ${positional[0]}.`);
  for (const id of [opts.id, positional[0]]) if (id !== undefined && !JOB_ID.test(id)) throw new Error(`Invalid job ID: ${id}.`);
  for (const [key, [min, max, integer]] of Object.entries(NUMBERS)) {
    if (opts[key] === undefined) { if (key in DEFAULTS) opts[key] = DEFAULTS[key]; continue; }
    const value = Number(opts[key]);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
      throw new Error(`--${key} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}.`);
    opts[key] = value;
  }
  if (opts.url && opts.pid) throw new Error('Use either --url or --pid, not both.');
  return { opts, positional };
}

async function readStdin() {
  if (process.stdin.isTTY) throw new Error('--file - expects the script on standard input.');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '');
}

async function main(argv) {
  const [command, ...args] = argv;
  const { opts, positional } = parseArgs(command, args);
  if (opts.help) { console.log(HELP); return; }
  if (opts.version) { console.log(VERSION); return; }
  if (command === 'list') { console.log(JSON.stringify(await discover(), null, 2)); return; }
  let base = opts.url || (!opts.pid && process.env.BLENDER_BRIDGE_URL);
  if (!base) {
    const instances = (await discover()).filter(item => !opts.pid || item.pid === opts.pid);
    if (instances.length !== 1) throw new Error(`Expected one Blender; found ${instances.length}. Use list and --pid/--url.`);
    base = instances[0].url;
  }
  localOrigin(base); // A bad endpoint is rejected before any job ID is issued or anything is sent.
  let result;
  if (command === 'health') result = await request(base, '/api/health');
  else if (['status', 'wait', 'cancel'].includes(command)) {
    const [id] = positional;
    if (command === 'wait') result = await wait(base, id, { timeout: opts.timeout });
    else {
      try {
        result = checkJob(await request(base, `/api/jobs/${encodeURIComponent(id)}${command === 'cancel' ? '/cancel' : ''}`,
          command === 'cancel' ? { method: 'POST', body: {} } : {}), id);
      } catch (error) {
        // 409 (cancel refused for a running native render) is a definite answer about the request.
        // A lost reply, an invalid one or 404 (unknown/evicted record) says nothing about whether the job ran.
        if (error.status === 409 || error.status === 400) throw error;
        if (error.status === 404) throw Object.assign(new Error(`Job ${id} is unknown or evicted (${error.message}). Whether it ran cannot be determined; inspect the scene and health.session before retrying.`), { unknown: true });
        if (error.unknown) throw error;
        throw Object.assign(new Error(`Cannot resolve job ${id}: ${error.message}. Its outcome is unknown; query again before retrying.`), { unknown: true });
      }
    }
  } else {
    let code;
    if (command === 'screenshot') code = screenshotCode(resolve(opts.output));
    else if (command === 'render') code = renderCode(opts.output ? resolve(opts.output) : undefined, opts.scene);
    else code = opts.file === '-' ? await readStdin() : await readFile(opts.file, 'utf8');
    if (command === 'exec' && !code.trim()) throw new Error('Script is empty.');
    const id = opts.id || randomUUID();
    console.error(JSON.stringify({ id, url: base, note: 'Timeout is not cancellation; query this ID before retrying.' }));
    try {
      result = checkJob(await submit(base, code, { id, interval: opts.interval, ttl: opts.ttl }), id);
    } catch (error) {
      // Only explicit refusals prove nothing ran: bad request, refused origin/host, missing route, ID conflict, oversized body, capacity/stopped.
      if (REJECTED.has(error.status)) throw error;
      throw Object.assign(new Error(`Submission outcome unknown for ${id}: ${error.message}. Query this ID and inspect the scene; do not resubmit.`), { unknown: true });
    }
    if (!opts['no-wait']) result = await wait(base, id, { timeout: opts.timeout });
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.status && terminal.has(result.status) && result.status !== 'succeeded') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = error.unknown ? 2 : 1; });
}
