// DSH-native adapter for the shared Blender Bridge.
//
// Registers two model tools:
//   blender_execute — run Python/bpy in the running Blender (protocol 2 job API)
//   blender_bridge  — health / list / status / wait / cancel
//
// Protocol logic lives entirely in the shared public client
// (../../plugins/blender-bridge/skills/blender-bridge/scripts/blender-bridge.mjs),
// so DSH and every other agent run the same client. This file only shapes tool
// arguments, output values and model-visible guidance.
//
// Endpoint selection: there is no implicit fixed port. Unless `base`, the row
// config `base` or BLENDER_BRIDGE_URL is given, the adapter discovers live
// instances and only proceeds when exactly one answers. With zero or several
// instances it refuses to guess and tells the caller to run `list` and pass an
// explicit base; a status/wait/cancel call reuses the base recorded for that job
// ID so it never queries a different Blender instance than the one that ran it.
//
// Failure semantics that the tool text must preserve:
//   - a wait timeout is NOT a cancellation; the job keeps running;
//   - nothing is ever replayed automatically: query the same ID instead;
//   - a failed query does not prove the code did not run;
//   - only the client's explicit pre-dispatch failures mean "safe to retry".

import { randomUUID } from 'node:crypto';
import {
  request,
  submit,
  wait,
  discover,
} from '../../plugins/blender-bridge/skills/blender-bridge/scripts/blender-bridge.mjs';

export const name = 'tool-blender-bridge';
export const inject = ['tools'];

const ENV_BASE =
  typeof process.env.BLENDER_BRIDGE_URL === 'string' ? process.env.BLENDER_BRIDGE_URL.trim() : '';
const DEFAULT_WAIT_SECONDS = 60;
const MAX_WAIT_SECONDS = 600;
const DEFAULT_TTL_SECONDS = 30;
const MAX_TTL_SECONDS = 3600;
const DEFAULT_INTERVAL_SECONDS = 0.2;
const MIN_INTERVAL_SECONDS = 0.05;
const MAX_INTERVAL_SECONDS = 10;
const MAX_TRACKED_JOBS = 128;
const VALID_ID = /^[A-Za-z0-9_-]{1,100}$/;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired', 'interrupted']);
const BRIDGE_ACTIONS = ['health', 'list', 'status', 'wait', 'cancel'];

const BASE_PROPERTIES = {
  ok: { type: 'boolean', description: 'Whether the bridge interaction itself succeeded.' },
  status: { type: 'integer', description: 'HTTP status of the underlying call, or 0 when the transport failed.' },
  outcome: {
    type: 'string',
    description:
      'succeeded | failed | cancelled | expired | interrupted | pending | unknown | rejected | not-submitted.',
  },
  state: { type: 'string', description: 'Raw job status reported by Blender, when known.' },
  id: { type: 'string', description: 'Job ID; the stable handle for later status/wait/cancel calls.' },
  result: { type: 'string', description: 'Final return value (StopIteration value of the generator, or the function return).' },
  error: { type: 'string', description: 'Failure or transport error; for a failed job this is the Python traceback.' },
  logs: { type: 'array', items: { type: 'string' }, description: 'Captured print/stdout lines, newest last.' },
  progress: { type: 'string', description: 'The most recent yielded progress value (visible step).' },
  steps: { type: 'integer', description: 'How many yielded steps have completed.' },
  executionMayHaveOccurred: {
    type: 'boolean',
    description: 'True when the code may have run (or is still running) despite a failed/unknown outcome.',
  },
  url: { type: 'string', description: 'Blender bridge endpoint that handled the call.' },
  hint: { type: 'string', description: 'Recovery or follow-up guidance.' },
};

const BASE_REQUIRED = [
  'ok',
  'status',
  'outcome',
  'state',
  'id',
  'result',
  'error',
  'logs',
  'progress',
  'steps',
  'executionMayHaveOccurred',
  'url',
  'hint',
];

function outputSchema(extra = {}) {
  return {
    type: 'object',
    properties: { ...BASE_PROPERTIES, ...extra },
    required: BASE_REQUIRED,
    additionalProperties: false,
  };
}

function text(value) {
  return [{ type: 'text', text: value }];
}

function truncate(value, maxChars = 12_000, maxLines = 200) {
  const lines = String(value ?? '').split('\n');
  const kept = lines.slice(0, maxLines).join('\n');
  const clipped = kept.length > maxChars ? `${kept.slice(0, maxChars)}\n…[truncated]` : kept;
  return lines.length > maxLines ? `${clipped}\n…[truncated: ${lines.length - maxLines} more lines]` : clipped;
}

/**
 * Wait for a job while remembering the last snapshot.
 *
 * The shared client throws on its wait deadline without returning the last
 * snapshot, so the adapter keeps it to answer with an honest `pending` value
 * (with progress/steps) instead of losing the visible state.
 */
async function waitTracked(base, id, { timeoutSeconds, signal }) {
  let last = null;
  try {
    const job = await wait(base, id, {
      timeout: timeoutSeconds,
      signal,
      onProgress: (snapshot) => {
        if (snapshot) last = snapshot;
      },
    });
    return { job, timedOut: false };
  } catch (error) {
    const aborted = signal?.aborted === true || error?.name === 'AbortError';
    const queryFailed = typeof error?.status === 'number';
    if (last && !aborted && !queryFailed) return { job: last, timedOut: true };
    throw error;
  }
}

function normalizeBase(value) {
  let base = typeof value === 'string' && value.trim() ? value.trim() : '';
  if (!base) return '';
  base = base.replace(/\/+$/, '');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) base = `http://${base}`;
  return base;
}

function clamp(value, fallback, min, max) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}

function clampSeconds(value, fallback, min, max) {
  if (!Number.isFinite(value)) return fallback;
  return Math.round(Math.min(Math.max(value, min), max) * 1000) / 1000;
}

/** Explicit endpoint: tool argument, row config, or environment. */
function explicitBase(argsBase, configBase) {
  const fromArgs = normalizeBase(argsBase);
  if (fromArgs) return fromArgs;
  const fromConfig = normalizeBase(configBase);
  if (fromConfig) return fromConfig;
  return normalizeBase(ENV_BASE);
}

function rememberBase(track, id, base) {
  if (!id || !base) return;
  if (track.has(id)) track.delete(id);
  track.set(id, base);
  while (track.size > MAX_TRACKED_JOBS) track.delete(track.keys().next().value);
}

/**
 * Pick the endpoint for a call.
 *
 * No implicit 6418 fallback: a caller that did not name an endpoint only gets the
 * unique live instance. Zero or several instances are an error, never a guess —
 * guessing could run Python in the wrong scene.
 */
async function resolveTarget({ argsBase, configBase, track, id, requireKnown = false }) {
  const explicit = explicitBase(argsBase, configBase);
  if (explicit) {
    rememberBase(track, id, explicit);
    return { base: explicit, source: 'explicit' };
  }
  if (id) {
    const remembered = track.get(id);
    if (remembered) return { base: remembered, source: 'job' };
  }
  if (requireKnown) {
    throw new AdapterError('Original endpoint for this job ID is not recorded.', {
      notDispatched: true,
      hint: 'Pass the original base explicitly for status/wait/cancel. Do not select a different instance merely because it is the only one currently open.',
    });
  }
  const instances = normalizeInstances(await discover());
  if (instances.length === 1) {
    const base = instances[0].url;
    rememberBase(track, id, base);
    return { base, source: 'discovered' };
  }
  const message =
    instances.length === 0
      ? 'No Blender instance with the Blender Bridge is answering.'
      : `${instances.length} Blender instances are answering, so the target is ambiguous.`;
  throw Object.assign(new AdapterError(message, {
    notDispatched: true,
    hint:
      instances.length === 0
        ? 'Open Blender with the Blender Bridge add-on enabled, then call blender_bridge {"action":"list"} and pass the reported base (or set BLENDER_BRIDGE_URL). Nothing was submitted.'
        : 'Call blender_bridge {"action":"list"}, then pass one of the reported urls as `base` explicitly. Nothing was submitted.',
  }));
}

function autoSelectNote(source, base) {
  return source === 'discovered'
    ? `No base given: used the only discovered Blender instance (${base}). Pass base explicitly to pin it.`
    : '';
}

function mergeNote(value, note) {
  if (!note) return value;
  return { ...value, hint: value.hint ? `${value.hint} ${note}` : note };
}

function logLines(value) {
  if (!Array.isArray(value)) return [];
  return value.map((line) => String(line));
}

function baseValue(fields) {
  return {
    ok: true,
    status: 200,
    outcome: 'pending',
    state: '',
    id: '',
    result: '',
    error: '',
    logs: [],
    progress: '',
    steps: 0,
    executionMayHaveOccurred: false,
    url: '',
    hint: '',
    ...fields,
  };
}

/** Ordered outcome for a job snapshot. */
function outcomeOf(snapshot) {
  const state = typeof snapshot?.status === 'string' ? snapshot.status : '';
  if (state === 'succeeded') return 'succeeded';
  if (TERMINAL.has(state)) return state;
  return 'pending';
}

/** True when executing the snippet may already have produced side effects. */
function mayHaveOccurred(snapshot) {
  const outcome = outcomeOf(snapshot);
  if (outcome === 'succeeded' || outcome === 'failed' || outcome === 'interrupted') return true;
  if (outcome === 'cancelled') return Number(snapshot?.steps ?? 0) > 0;
  if (outcome === 'expired') return false;
  return true; // pending: queued may run at any moment, running certainly may
}

function pendingHint(snapshot) {
  const state = snapshot?.status;
  if (state === 'queued') {
    return 'Queued. Query it again with the same ID; do not resubmit.';
  }
  return 'Still running. Poll it with the same ID; a wait timeout never cancels this job.';
}

function resultHint(outcome, snapshot) {
  switch (outcome) {
    case 'pending':
      return pendingHint(snapshot);
    case 'expired':
      return 'The job expired in the queue before any code ran, so nothing was executed and resubmitting is safe.';
    case 'cancelled':
      return 'Cancelled. Steps that already yielded are not rolled back; re-running is a new decision.';
    case 'interrupted':
      return 'Blender reloaded or the bridge stopped while this job was active; earlier steps may have left partial changes.';
    case 'failed':
      return 'The job failed; read the traceback in error before deciding whether to run any of it again.';
    default:
      return '';
  }
}

/** Value built from a job snapshot. */
function jobValue(snapshot, base, hint = '') {
  const outcome = outcomeOf(snapshot);
  return baseValue({
    ok: true,
    status: 200,
    outcome,
    state: typeof snapshot?.status === 'string' ? snapshot.status : '',
    id: typeof snapshot?.id === 'string' ? snapshot.id : '',
    result: String(snapshot?.result ?? ''),
    error: String(snapshot?.error ?? ''),
    logs: logLines(snapshot?.logs),
    progress: String(snapshot?.progress ?? ''),
    steps: Number.isInteger(snapshot?.steps) ? snapshot.steps : 0,
    executionMayHaveOccurred: mayHaveOccurred(snapshot),
    url: base,
    hint: hint || resultHint(outcome, snapshot),
  });
}

class AdapterError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AdapterError';
    Object.assign(this, details);
  }
}

/**
 * Value for a call that did not produce a job snapshot.
 *
 * `context.action` says what was attempted, which decides whether an error means
 * "nothing was submitted" (safe to retry) or "outcome unknown" (query the ID).
 * The shared client only reports HTTP status; any submit transport failure or
 * 5xx is treated as an unknown outcome, never as a rejection, matching the
 * protocol rule that a lost submission response must be resolved by ID.
 */
function failure(error, context = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const id =
    typeof error?.id === 'string' && error.id
      ? error.id
      : typeof context.id === 'string'
        ? context.id
        : '';
  const status = Number.isInteger(error?.status) ? error.status : 0;
  const rawState = typeof error?.state === 'string' ? error.state : '';
  const action = context.action || '';
  const querying = action === 'status' || action === 'wait' || action === 'cancel';
  const notSubmitted = error?.notDispatched === true || rawState === 'not-submitted';
  const uncertainSubmit = action === 'execute' && !notSubmitted && (status === 0 || status >= 500);
  const lookUp = !notSubmitted && (uncertainSubmit || querying || rawState === 'unknown');
  const terminalError = TERMINAL.has(rawState);

  let outcome = 'rejected';
  if (notSubmitted) outcome = 'not-submitted';
  else if (terminalError) outcome = rawState;
  else if (lookUp) outcome = rawState === 'queued' || rawState === 'running' ? 'pending' : 'unknown';

  const customHint = typeof error?.hint === 'string' && error.hint ? error.hint : '';

  let hint;
  if (customHint) {
    hint = customHint;
  } else if (notSubmitted) {
    hint = 'Nothing was submitted, so retrying is safe once the bridge is reachable.';
  } else if (querying && status === 404) {
    hint =
      'Unknown or evicted job ID. Inspect the Blender scene/state before running anything again; never resubmit a write blindly.';
  } else if (action === 'wait') {
    hint =
      'The wait ended, but this job was NOT cancelled: query the same ID again. Never resubmit a write under a new ID.';
  } else if (uncertainSubmit) {
    hint =
      'The submission response was lost, so it is unknown whether the code ran. Query this same ID before doing anything else; do not resubmit.';
  } else if (lookUp && id) {
    hint = 'This failure does not prove the code did not run. Query the same ID before repeating a write.';
  } else if (action === 'execute') {
    hint =
      status === 409
        ? 'That ID already belongs to different work. Query it by ID, then use a fresh ID only if a new run is really wanted.'
        : 'The bridge rejected the submission before execution.';
  } else {
    hint = 'The bridge call failed; check that Blender is running with the Blender Bridge add-on enabled.';
  }

  const mayHaveOccurred = !notSubmitted && (lookUp || terminalError);

  return baseValue({
    ok: false,
    status,
    outcome,
    state: rawState,
    id,
    result: '',
    error: message,
    logs: [],
    progress: '',
    steps: 0,
    executionMayHaveOccurred: mayHaveOccurred,
    url: typeof context.base === 'string' ? context.base : '',
    hint,
  });
}

function renderValue(action, value) {
  const header = [
    action ? `${action}:` : 'blender_execute:',
    value.outcome,
    value.id ? `job ${value.id}` : '',
    value.state && value.state !== value.outcome ? `state=${value.state}` : '',
    value.steps ? `${value.steps} step(s)` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const body = [];
  if (value.outcome === 'pending' && value.progress) body.push(`progress: ${value.progress}`);
  if (value.result) body.push(value.result);
  if (value.logs.length) body.push(value.logs.join('\n'));
  if (value.error) body.push(`${value.outcome === 'cancelled' ? 'reason' : 'error'}: ${value.error}`);
  if (value.hint) body.push(`note: ${value.hint}`);
  return text(truncate([header, ...body].join('\n')));
}

function renderHealth(value) {
  if (!value.ok) return renderValue('blender_bridge health', value);
  const lines = [
    `blender_bridge health: Blender ${value.blender || '?'} / bridge ${value.bridgeVersion || '?'} / protocol ${value.protocol || '?'}`,
    value.file ? `file: ${value.file}` : '',
    value.background ? 'mode: background (GUI redraw is not guaranteed)' : '',
    value.url ? `endpoint: ${value.url}` : '',
    value.error ? `error: ${value.error}` : '',
    value.hint ? `note: ${value.hint}` : '',
  ].filter(Boolean);
  return text(truncate(lines.join('\n')));
}

function renderList(value) {
  const instances = Array.isArray(value.instances) ? value.instances : [];
  if (instances.length === 0) {
    return text(
      'list: no Blender instance with the Blender Bridge is answering.\nnote: open Blender and enable the Blender Bridge add-on (it auto-starts on 127.0.0.1:6418).',
    );
  }
  return text(
    truncate([`list: ${instances.length} Blender instance(s)`, ...instances.map((line) => `- ${line}`), value.hint ? `note: ${value.hint}` : ''].filter(Boolean).join('\n')),
  );
}

function describeInstance(entry) {
  const url = entry?.url ?? '';
  const blender = entry?.blender ?? '';
  const file = entry?.file ?? '';
  const pid = entry?.pid ?? '?';
  const protocol = entry?.protocol ?? '1';
  const background = entry?.background === true ? ' background' : '';
  return `${blender || 'unknown Blender'}  ${url}  pid=${pid}${file ? `  file=${file}` : ''}${background}  protocol=${protocol}`;
}

function normalizeInstances(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry) => entry && (typeof entry.url === 'string' || Number.isInteger(entry.port)))
    .map((entry) => ({
      ...entry,
      url: typeof entry.url === 'string' && entry.url ? entry.url.replace(/\/+$/, '') : `http://127.0.0.1:${entry.port}`,
    }));
}

/** `blender_execute` — same tool name as before, now backed by the job API. */
export function blenderExecuteTool(config = {}, track = new Map()) {
  const configBase = typeof config.base === 'string' ? config.base : '';
  return {
    name: 'blender_execute',
    description:
      'Execute Python/bpy inside the running Blender through the local Blender Bridge (protocol 2 job API). ' +
      'Blender must be open with the Blender Bridge add-on enabled. Endpoint selection: pass `base` explicitly, or set ' +
      'BLENDER_BRIDGE_URL; otherwise the adapter discovers live instances and only proceeds when exactly one answers. ' +
      'With zero or several instances it submits nothing and asks for `blender_bridge {"action":"list"}` first. ' +
      '`code` is the body of a Python function executed on Blender\'s MAIN thread: use `return <expr>` for a final value ' +
      'and print(...) for logs. Make long operations generators: `yield "<progress>"` between stages; each yield lets ' +
      'Blender redraw and is reported as progress/steps (a fully synchronous script still blocks the UI until it ' +
      'returns). Every call gets a job ID that is kept before submission, so a wait timeout or interruption is NOT a ' +
      'failure and NOT a cancellation: query the same ID (same base) with blender_bridge {"action":"status","id":"…"} ' +
      'instead of running the code again.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python/bpy function body. `return` yields the value; print(...) becomes logs; `yield` marks progress steps.' },
        id: { type: 'string', description: 'Reuse a specific job ID (same ID + same code/interval/ttl returns the existing job; changing any of them returns 409).' },
        wait: { type: 'boolean', description: 'Wait for the result. Default true; false returns the job ID immediately for long or interactive work.' },
        timeoutSeconds: { type: 'integer', description: `Wait budget in seconds, 1..${MAX_WAIT_SECONDS} (default ${DEFAULT_WAIT_SECONDS}). Reaching it never cancels the job.` },
        queueTimeoutSeconds: { type: 'integer', description: `Queue TTL in seconds, 1..${MAX_TTL_SECONDS} (default ${DEFAULT_TTL_SECONDS}); a job still queued after this expires without running.` },
        intervalSeconds: { type: 'number', description: `Seconds between visible generator steps, ${MIN_INTERVAL_SECONDS}..${MAX_INTERVAL_SECONDS} (default ${DEFAULT_INTERVAL_SECONDS}); raise it to let the user watch each step.` },
        base: { type: 'string', description: 'Explicit bridge origin, e.g. http://127.0.0.1:6418. Required when several Blender instances are open.' },
      },
      required: ['code'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema(),
      render: (_args, value) => renderValue('blender_execute', value),
    },
    async execute(args, exec) {
      const code = args?.code;
      if (typeof code !== 'string' || code.trim() === '') {
        return failure(new AdapterError('`code` must be a non-empty Python body.', { state: 'rejected', notDispatched: true }), {
          action: 'execute',
        });
      }
      if (args?.id !== undefined && !VALID_ID.test(String(args.id))) {
        return failure(new AdapterError('`id` must be 1..100 letters, digits, hyphens or underscores.', { state: 'rejected', notDispatched: true }), {
          action: 'execute',
        });
      }

      const id = typeof args?.id === 'string' && args.id ? args.id : randomUUID();
      let target;
      try {
        target = await resolveTarget({ argsBase: args?.base, configBase, track, id });
      } catch (error) {
        // Nothing is submitted until the endpoint is unambiguous.
        return failure(error, { action: 'execute', id: typeof args?.id === 'string' ? args.id : '' });
      }
      const base = target.base;
      const note = autoSelectNote(target.source, base);
      const signal = exec?.signal;
      const timeoutSeconds = clamp(args?.timeoutSeconds, DEFAULT_WAIT_SECONDS, 1, MAX_WAIT_SECONDS);
      const ttlSeconds = clamp(args?.queueTimeoutSeconds, DEFAULT_TTL_SECONDS, 1, MAX_TTL_SECONDS);
      const intervalSeconds = clampSeconds(args?.intervalSeconds, DEFAULT_INTERVAL_SECONDS, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS);

      let accepted;
      try {
        accepted = await submit(base, code, {
          id,
          interval: intervalSeconds,
          ttl: ttlSeconds,
          signal,
        });
      } catch (error) {
        return mergeNote(failure(error, { action: 'execute', id, base }), note);
      }

      if (accepted && TERMINAL.has(accepted.status)) return mergeNote(jobValue(accepted, base), note);
      if (args?.wait === false) {
        return mergeNote(jobValue(accepted ?? { id, status: 'queued' }, base, pendingHint(accepted)), note);
      }

      try {
        const { job, timedOut } = await waitTracked(base, id, { timeoutSeconds, signal });
        const value = jobValue(job, base);
        return mergeNote(
          timedOut
            ? {
                ...value,
                hint: 'Wait budget ended; this job was NOT cancelled. Query the same ID again with status or wait, and never resubmit a write under a new ID.',
              }
            : value,
          note,
        );
      } catch (error) {
        // The job was accepted; an error here only ends the client-side wait.
        return mergeNote(failure(error, { action: 'wait', id, base }), note);
      }
    },
  };
}

/** `blender_bridge` — management verbs for one executor. */
export function blenderBridgeTool(config = {}, track = new Map()) {
  const configBase = typeof config.base === 'string' ? config.base : '';
  return {
    name: 'blender_bridge',
    description:
      'Manage the Blender Bridge and its jobs. Actions: `list` (all Blender instances answering discovery; run it first ' +
      'when several are open), `health` (bridge/protocol version, Blender version, file, pid), `status` (one job by ID, ' +
      'including progress/steps/result/logs), `wait` (poll one job until terminal or the budget ends), `cancel` (queued ' +
      'jobs stop immediately; a running generator stops between yielded steps; a fully synchronous script cannot be ' +
      'interrupted). Without an explicit `base`, `health` only proceeds when exactly one instance answers, while ' +
      'status/wait/cancel reuse the base recorded for that job ID so they never query a different Blender. A wait ' +
      'timeout is not a failure or cancellation: keep the ID and query it again. Never resubmit a write under a new ID ' +
      'while the old outcome is unknown.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: BRIDGE_ACTIONS, description: 'Operation to perform. Use `list` before passing `base` when several Blender instances are open.' },
        id: { type: 'string', description: 'Job ID for status, wait and cancel.' },
        base: { type: 'string', description: 'Explicit bridge origin from `list`, e.g. http://127.0.0.1:6418. Overrides the base recorded for the job ID.' },
        timeoutSeconds: { type: 'integer', description: `Wait budget for the wait action, 1..${MAX_WAIT_SECONDS} (default ${DEFAULT_WAIT_SECONDS}).` },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        blender: { type: 'string', description: 'Blender version reported by health.' },
        bridgeVersion: { type: 'string', description: 'Bridge add-on version reported by health.' },
        protocol: { type: 'string', description: 'Protocol revision reported by health.' },
        pid: { type: 'integer', description: 'Blender process id reported by health.' },
        session: { type: 'string', description: 'Bridge session id reported by health.' },
        file: { type: 'string', description: 'Currently open .blend file reported by health.' },
        background: { type: 'boolean', description: 'True when Blender runs without a GUI.' },
        instances: { type: 'array', items: { type: 'string' }, description: 'One line per discovered Blender instance (list).' },
      }),
      render(args, value) {
        if (args?.action === 'health') return renderHealth(value);
        if (args?.action === 'list') return renderList(value);
        return renderValue(`blender_bridge ${args?.action ?? ''}`.trim(), value);
      },
    },
    async execute(args, exec) {
      const action = args?.action;
      const signal = exec?.signal;
      if (!BRIDGE_ACTIONS.includes(action)) {
        return failure(new AdapterError(`action must be one of ${BRIDGE_ACTIONS.join(', ')}.`, { state: 'rejected', notDispatched: true }), { action: String(action) });
      }
      if ((action === 'status' || action === 'wait' || action === 'cancel') && !VALID_ID.test(String(args?.id ?? ''))) {
        return failure(new AdapterError(`${action} requires a valid job ID in \`id\`.`, { state: 'rejected', notDispatched: true }), { action });
      }
      const id = typeof args?.id === 'string' ? args.id : '';

      if (action === 'list') {
        try {
          const entries = normalizeInstances(await discover());
          return baseValue({
            ok: true,
            status: 200,
            outcome: 'succeeded',
            url: '',
            result: '',
            instances: entries.map(describeInstance),
            hint: entries.length > 1 ? 'Pass `base` with one reported url to target exactly one Blender instance.' : '',
          });
        } catch (error) {
          return failure(error, { action: 'list' });
        }
      }

      let target;
      try {
        target = await resolveTarget({ argsBase: args?.base, configBase, track, id, requireKnown: action !== 'health' });
      } catch (error) {
        // Ambiguous or absent target: do not touch any endpoint.
        return failure(error, { action, id });
      }
      const base = target.base;
      const note = autoSelectNote(target.source, base);

      if (action === 'health') {
        try {
          const health = await request(base, '/api/health', { signal });
          const protocol = health?.protocol;
          const value = baseValue({
            ok: true,
            status: 200,
            outcome: 'succeeded',
            state: '',
            id: '',
            result: health?.url || base,
            error: '',
            logs: [],
            progress: '',
            steps: 0,
            executionMayHaveOccurred: false,
            url: base,
            hint:
              protocol === 2
                ? ''
                : 'This Blender bridge predates protocol 2: only the legacy synchronous endpoint is available.',
            blender: String(health?.blender ?? ''),
            bridgeVersion: String(health?.bridge ?? ''),
            protocol: String(protocol ?? '1'),
            session: String(health?.session ?? ''),
            file: String(health?.file ?? ''),
            background: health?.background === true,
          });
          if (Number.isInteger(health?.pid)) value.pid = health.pid;
          return mergeNote(value, note);
        } catch (error) {
          return mergeNote(failure(error, { action: 'health', base }), note);
        }
      }

      try {
        if (action === 'status') {
          const job = await request(base, `/api/jobs/${encodeURIComponent(id)}`, { signal });
          return mergeNote(jobValue(job, base), note);
        }
        if (action === 'wait') {
          const timeoutSeconds = clamp(args?.timeoutSeconds, DEFAULT_WAIT_SECONDS, 1, MAX_WAIT_SECONDS);
          const { job, timedOut } = await waitTracked(base, id, { timeoutSeconds, signal });
          const value = jobValue(job, base);
          return mergeNote(
            timedOut
              ? {
                  ...value,
                  hint: 'Wait budget ended; this job was NOT cancelled. Query the same ID again (status/wait) instead of resubmitting.',
                }
              : value,
            note,
          );
        }
        const job = await request(base, `/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {}, signal });
        const value = jobValue(job, base);
        if (value.outcome === 'cancelled') {
          return mergeNote({ ...value, hint: 'Cancelled before execution (or between steps). Steps that already ran are not rolled back.' }, note);
        }
        if (value.outcome === 'pending') {
          return mergeNote(
            {
              ...value,
              hint:
                job?.status === 'queued'
                  ? 'Cancellation accepted for a queued job.'
                  : 'Cancellation requested; it takes effect between yielded steps. A fully synchronous script cannot be interrupted.',
            },
            note,
          );
        }
        return mergeNote({ ...value, hint: `Cancel requested, but the job is already ${value.outcome}; there is nothing left to stop.` }, note);
      } catch (error) {
        return mergeNote(failure(error, { action, id, base }), note);
      }
    },
  };
}

/** Instantiate both tools (used by the plugin and by tests). */
export function createTools(config = {}) {
  const track = new Map();
  return [blenderExecuteTool(config, track), blenderBridgeTool(config, track)];
}

/** Minimal `blender_execute` used when the real tools cannot be registered. */
export function fallbackExecuteTool(message) {
  return {
    name: 'blender_execute',
    description: `Unavailable. ${message}`,
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'Python body (currently unavailable).' } },
      required: ['code'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          status: { type: 'integer' },
          result: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok', 'status', 'result', 'error'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.error }],
    },
    async execute() {
      return { ok: false, status: 0, result: '', error: message };
    },
  };
}

/** DSH plugin entry. */
export function apply(ctx, config = {}) {
  const tools = createTools(config);
  const registered = [];
  for (const tool of tools) {
    try {
      ctx.tools.register(tool);
      registered.push(tool.name);
    } catch (error) {
      console.error(`[blender-bridge] could not register ${tool.name}: ${error?.message ?? error}`);
    }
  }
  if (!registered.includes('blender_execute')) {
    const message = `blender_execute could not be registered in this host: ${registered.length ? 'registration rejected' : 'no tool was accepted'}. See the DSH log for the host's validation message.`;
    try {
      ctx.tools.register(fallbackExecuteTool(message));
    } catch (error) {
      console.error(`[blender-bridge] fallback registration also failed: ${error?.message ?? error}`);
    }
  }
  return { tools };
}
