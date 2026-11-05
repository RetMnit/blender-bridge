// Local job journal for the CLI: remembers each submitted job ID with its endpoint so a
// caller whose process was killed, or whose stderr was lost, can find the ID again
// (`recent`) and query it without naming the target. Blender stays authoritative for
// job state; the journal only records what this machine sent and last heard.
//
// Writes are best effort: an unwritable journal (for example a sandboxed agent without
// access to its home directory) never blocks a command; the CLI warns instead and the
// printed job ID remains the handle. Same file format as Unity Bridge's CLI journal.
//
// Every append and compaction holds a lock file next to the journal, so concurrent CLI
// processes cannot lose each other's lines when the journal is compacted.
import { open, mkdir, readFile, writeFile, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const MAX_BYTES = 1024 * 1024;
const KEEP_LINES = 2000;
const KEEP_BYTES = MAX_BYTES / 2;
const LOCK_WAIT_MS = 10000;
const LOCK_STALE_MS = 15000;

export class Journal {
  constructor(file) { this.file = file; }

  /** The tool's journal: `envVar` names the file, "off" disables recording (every method then does nothing). */
  static forTool(name, envVar) {
    const configured = process.env[envVar];
    if (configured?.trim().toLowerCase() === 'off') return new Journal(null);
    return new Journal(configured || path.join(homedir(), `.${name}`, 'jobs.jsonl'));
  }

  /**
   * Durably append one entry, compacting the file when it has grown past MAX_BYTES.
   * Throws when the entry could not be written; returns a warning when only compaction failed.
   */
  async append(entry) {
    if (!this.file) return '';
    await mkdir(path.dirname(this.file), { recursive: true });
    return this.#locked(async () => {
      const handle = await open(this.file, 'a');
      try {
        await handle.writeFile(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
        await handle.sync();
      } finally { await handle.close(); }
      try { if ((await stat(this.file)).size > MAX_BYTES) await this.#trim(); }
      catch (error) { return `Job journal ${this.file} was updated but could not be compacted (${error.message}).`; }
      return '';
    });
  }

  /** Append without throwing; returns a warning string, or '' when all went well. */
  async note(entry) {
    try { return await this.append(entry); }
    catch (error) { return `Job journal ${this.file} could not be updated (${error.message}); keep the printed job ID, it may be the only handle.`; }
  }

  async #locked(work) {
    const lock = `${this.file}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try { await (await open(lock, 'wx')).close(); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // A lock left behind by a killed process must not block the journal forever.
        const age = await stat(lock).then(info => Date.now() - info.mtimeMs, () => 0);
        if (age > LOCK_STALE_MS) { await unlink(lock).catch(() => {}); continue; }
        if (Date.now() > deadline) throw new Error(`journal is locked by another process (${lock})`);
        await sleep(15);
      }
    }
    try { return await work(); }
    finally { await unlink(lock).catch(() => {}); }
  }

  async #trim() {
    // Compact rather than cut: one complete snapshot per job (newest jobs first, within both
    // limits), so a kept job never loses the endpoint/session recorded at submission.
    const lines = [];
    let bytes = 0;
    for (const job of await this.jobs()) {
      if (lines.length >= KEEP_LINES) break;
      const line = JSON.stringify({ event: 'snapshot', at: job.updatedAt, ...job });
      bytes += Buffer.byteLength(line) + 1;
      if (bytes > KEEP_BYTES && lines.length) break;
      lines.push(line);
    }
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, `${lines.reverse().join('\n')}\n`, 'utf8');
    await rename(temp, this.file);
  }

  /**
   * One merged record per job, most recently submitted first. A job is its ID within one
   * target (Blender session, else Unity project, else endpoint URL), so a reused ID in another
   * project or session stays a separate job. Unreadable lines are skipped.
   */
  async jobs() {
    if (!this.file) return [];
    let text;
    try { text = await readFile(this.file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const byKey = new Map();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || typeof entry.id !== 'string') continue;
      const { at, event, submittedAt, updatedAt, ...fields } = entry;
      const key = jobKey(entry);
      const known = byKey.get(key) || { id: entry.id };
      if (event === 'snapshot') known.submittedAt = submittedAt ?? at;
      else if (event === 'submitted' || !known.submittedAt) known.submittedAt = at;
      Object.assign(known, Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null && value !== '')),
        { updatedAt: (event === 'snapshot' && updatedAt) || at });
      byKey.set(key, known);
    }
    return [...byKey.values()].sort((a, b) => String(b.submittedAt ?? '').localeCompare(String(a.submittedAt ?? '')));
  }

  /** The most recently submitted job with this ID, or undefined. */
  async find(id) { return (await this.jobs()).find(job => job.id === id); }

  /** Whether this ID is already recorded for the same target (session, project or endpoint). */
  async has(entry) {
    const key = jobKey(entry);
    return (await this.jobs()).some(job => jobKey(job) === key);
  }
}

function jobKey(entry) {
  const target = entry.session || (entry.projectPath ? String(entry.projectPath).toLowerCase() : '') || entry.url || '';
  return `${entry.id}\n${target}`;
}

/** First line of a script, shortened, so `recent` can tell jobs apart without storing code. */
export function summarize(code) {
  const line = String(code ?? '').split('\n').map(text => text.trim()).find(Boolean) || '';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/**
 * Bound the model-visible size of a job without changing it on the server.
 * Text fields keep their head; logs keep their newest lines. Returns the job unchanged
 * when nothing exceeds `maxChars`.
 */
export function budget(job, maxChars) {
  if (!maxChars || !job || typeof job !== 'object') return job;
  const copy = { ...job }, truncated = {};
  for (const key of ['result', 'error', 'progress']) {
    if (typeof copy[key] === 'string' && copy[key].length > maxChars) {
      truncated[key] = copy[key].length;
      copy[key] = `${copy[key].slice(0, maxChars)}…[truncated ${copy[key].length - maxChars} chars]`;
    }
  }
  if (Array.isArray(copy.logs)) {
    const kept = [];
    let used = 0;
    for (let i = copy.logs.length - 1; i >= 0; i--) {
      const line = String(copy.logs[i]);
      if (used + line.length > maxChars) {
        // Never drop everything: an oversized newest line keeps its end, where errors usually are.
        if (!kept.length) kept.unshift(`…${line.slice(-maxChars)}`);
        break;
      }
      kept.unshift(line);
      used += line.length;
    }
    if (kept.length < copy.logs.length) {
      truncated.logs = copy.logs.length;
      copy.logs = [`…[${copy.logs.length - kept.length} earlier lines omitted]`, ...kept];
    }
  }
  if (!Object.keys(truncated).length) return job;
  const note = 'Output was shortened by --max-chars; query the same ID without it for the full text.';
  return { ...copy, truncated, hint: copy.hint ? `${copy.hint} ${note}` : note };
}
