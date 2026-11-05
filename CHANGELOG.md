# Changelog

## 0.4.1 — 2026-11-05
- Client and plugin release; the addon and protocol 2 are unchanged (the addon still reports 0.4.0, and Blender does not need reinstalling).
- Claude Code plugin: `.claude-plugin/marketplace.json` at the repository root and `plugins/blender-bridge/.claude-plugin/plugin.json` reuse the same Skill and CLI as Codex.
- `exec --file -` reads the script from standard input, so agents can pass a heredoc instead of writing a temporary file.
- The CLI rejects unknown, duplicate, empty, missing and out-of-range options per command instead of ignoring them. Calls that used to pass silently, such as `status <id> --timeout 60`, now fail with a message. `--pid` takes precedence over `BLENDER_BRIDGE_URL`. `--help` documents every option and `--version` prints the client version without contacting Blender.
- Exit 2 (outcome unknown) now also covers a lost status/cancel reply, an unknown or evicted ID on `status`, and a submission answered with anything other than an explicit refusal (400, 401, 403, 404, 409, 503). Exit 1 is kept for refusals, failed jobs and an invalid or non-loopback endpoint, which is now rejected before a job ID is issued.
- DSH adapter: a failed or invalid poll during `wait` is reported as unknown instead of an expired wait budget.
- Shared client: `wait()` validates its budget and no longer throws on fractional seconds after a job was submitted; replies are checked by the new `checkJob()` so a reply for another ID or without a known status is never taken as success; `request()` refuses redirects and paths that leave the selected endpoint.
- The Skill is agent-neutral and notes that screenshot/render output folders must be visible to the Blender process.

## 0.4.0 — 2026-10-24
- Skip the automatic startup splash while restoring the original splash/autosave preferences; no preference file is saved.
- Add tracked asynchronous still rendering to the shared CLI and DSH adapter. Jobs remain running until Blender finishes or cancels; optional PNG outputs are published without overwriting existing files.
- Expose native render activity, per-job phase and elapsed time. Wait timeouts never cancel or detach rendering; native cancellation is observed through Blender handlers.
- Add real render/cancellation and startup preference regressions. Avoid the unsafe render_stats callback on Blender 5.2.

## 0.3.0
- Validated screenshots shared by Codex CLI and DSH's native screenshot action.
- Windows minimized captures temporarily restore only the target process window, yield for redraw and restore minimization on success, failure or cancellation.
- Black RGB frames are rejected before output publication; temporary PNGs are cleaned up and existing outputs are never overwritten.
- Bridge Stop closes active generators so window cleanup runs. Screenshot lifecycle, adapter recovery and actual GUI minimized/cancel tests added.

## 0.2.0
- Shared neutral Blender addon, Codex Skill/CLI and DSH adapter.
- Visible generator steps: one step per timer tick, active redraw and progress panel.
- Job IDs, bounded history, deduplication/conflicts, queue TTL, status/wait and cooperative cancellation.
- Verified per-instance discovery with port fallback and cached main-thread metadata.
- Legacy health/execute compatibility; browser Origin rejection, request size limit, persistent timer lifecycle and manual Stop that stays stopped.

## 0.1.0
- Original DSH-only Blender addon and synchronous execute endpoint.
