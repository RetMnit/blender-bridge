# Blender Bridge

Shared local Blender executor for Codex, Claude Code, DSH and other agents. Blender 3.6+ (tested with 5.2.0 LTS), Python standard library only; clients use Node 22+. Originally based on DSH Blender Bridge 0.1.0.

## Install

Clone a release from `https://github.com/RetMnit/blender-bridge`, then run:

```powershell
.\install-addon.ps1 -Version 5.2 -Enable
```

This installs `blender_bridge` into Blender's user addon directory and enables it for future launches, disabling the old `dsh_blender_bridge` in preferences. Existing user preferences are loaded and preserved. Close/reopen Blender after updating an open instance. Without `-Enable`, enable **Blender Bridge** under Preferences > Add-ons and disable **DSH Blender Bridge**. Old source need not be deleted. A viewport Sidebar > Bridge panel shows endpoint, progress and Start/Stop. Stop remains stopped.

The server binds loopback, preferring port 6418 and choosing a free port if occupied. Clients discover instances by PID/session using verified descriptors under the OS temp `blender-bridge` directory. Select an instance explicitly when more than one is open. Opening a blend file interrupts pending jobs; no code is replayed.

## Watch the agent work

The enabled addon skips the automatic startup splash so it cannot cover modeling steps. It temporarily disables splash display and preference autosave, then restores both original values after startup without saving preferences. Help > Splash Screen still works. This does not dismiss popups that were already open before addon activation; inspect the view before proceeding.

Each request runs Python on Blender's main thread. A single long script prevents the GUI from updating until it returns. Write short steps with `yield` between them:

```python
bpy.ops.mesh.primitive_cube_add()
cube = bpy.context.object
yield 'Created cube'
cube.scale.z = 2
yield 'Stretched cube'
return cube.name
```

Each yield lets Blender process input and redraw all areas before the next step (default 0.2 seconds, configurable). Objects must also be in the visible scene and viewport. This does not animate every individual bpy statement and cannot make blocking render/sleep/infinite loops responsive. Use GUI Blender for work the user should see.

## Codex

```text
codex plugin marketplace add https://github.com/RetMnit/blender-bridge.git --ref v0.4.2
codex plugin add blender-bridge@blender-bridge-tools
```

The plugin provides a Skill plus a portable CLI; no MCP server or hardcoded machine paths. New chats load newly installed skills. The CLI can also be used directly:

```text
node plugins/blender-bridge/skills/blender-bridge/scripts/blender-bridge.mjs list
node <client> health --pid <pid>
node <client> exec --pid <pid> --file steps.py --no-wait
node <client> wait <job-id> --pid <pid> --timeout 120
node <client> screenshot --pid <pid> --output <new-absolute.png>
```

Screenshots require addon 0.3.0+ and a GUI. On Windows a minimized target window is temporarily restored for two redraw ticks, then minimized again (also on cancellation or failure). Capture targets this Blender process only; ambiguous windows fail rather than guessing. The largest Blender window is selected. The scene, layout and saved files are unchanged. RGB pixels are checked before publishing: a black capture fails without creating the requested output. Existing files are never overwritten. View the returned PNG to verify the intended scene.

## Claude Code

The same plugin folder carries a Claude Code manifest (`.claude-plugin/marketplace.json` at the repository root and `plugins/blender-bridge/.claude-plugin/plugin.json`), sharing the Skill and CLI with Codex:

```text
claude plugin marketplace add https://github.com/RetMnit/blender-bridge.git#v0.4.2
claude plugin install blender-bridge@blender-bridge-tools
```

To upgrade, run `claude plugin marketplace remove blender-bridge-tools` and repeat both commands with the new tag; new sessions load the updated Skill. Claude runs the CLI with its own shell tool; no MCP server is involved.

Scripts can come from standard input with `exec --file -`: in Bash use a quoted heredoc (`<<'EOF'`); in Windows PowerShell 5.1 set `$OutputEncoding = [System.Text.UTF8Encoding]::new($false)` and pipe a single-quoted here-string, otherwise non-ASCII text becomes `?` before the client receives it. Screenshot and render outputs are written by Blender, so choose a folder Blender can see: an app packaged as MSIX on Windows (such as the Claude desktop app) has its writes under `%LOCALAPPDATA%`/`%TEMP%` redirected to a private copy.

Releases 0.4.1 and 0.4.2 change only the clients, plugins and documentation; the addon is unchanged (it still reports 0.4.0) and need not be reinstalled.

## DSH

Install this repository as a Git-tagged dependency and load `adapters/dsh/index.mjs` through your preset's module loader. The adapter imports the shared client using relative paths; use its `blender_execute` and `blender_bridge` tools. Restart the DSH host after changing execution modules; configuration hot reload does not replace cached JavaScript modules.

Use `blender_bridge {"action":"screenshot","base":"<selected-url>","output":"<new-absolute.png>"}` for the same validated capture as Codex. It supports job IDs, waiting and status/cancel recovery. Raw `bpy.ops.screen.screenshot` bypasses these protections.

## Execution and recovery

### Tracked still renders (0.4.0+)

```text
node <client> render --pid <pid> --output <new-absolute.png> --no-wait
node <client> status <returned-id> --pid <pid>
node <client> wait <returned-id> --pid <pid> --timeout 60
```

Omit output to keep only Blender's Render Result; use `--scene <name>` to select a scene. The DSH equivalent is `blender_bridge {"action":"render","base":"<selected-url>","output":"<new-absolute.png>","wait":false}`. Both use one tracked generator: the job remains running until Blender's completion/cancel callback and renderer teardown agree. Status carries render phase and elapsed time; no sample percentage is claimed. PNG publication never overwrites another file, and render output settings are restored.

A client timeout is not cancellation. Query the same ID. A queued render can be cancelled, but cancelling an already running render through the bridge returns 409 and continues tracking it. Use Escape in Blender's actual Render UI to cancel, then query the original job until it reports cancelled. Bridge Stop detaches monitoring and reports interrupted; it cannot forcibly stop Blender's native renderer. Normal exec that only calls INVOKE_DEFAULT still means "render started" and should not replace this command.

See [protocol](docs/protocol.md). Return values are display strings; print output is captured. Scripts have `bpy`, `C`, `D`, `context`, `mathutils`. Changes are not automatically undone or saved. A timeout/disconnect is not cancellation: query the printed job ID and original endpoint/session before retrying. IDs and results are held in memory (up to 128); restarting Blender does not replay work. A running generator can be cancelled between steps; prior mutations remain. Never expose this arbitrary Python executor outside loopback; untrusted browser Origin requests are rejected.

### CLI job journal (0.4.2+)

- Before submitting `exec`, `screenshot` or `render`, the CLI appends the job ID, endpoint, Blender PID and session, and the script's first line to `~/.blender-bridge/jobs.jsonl`, then appends each state it sees. `BLENDER_BRIDGE_JOURNAL` sets another file; `off` disables recording (the summary stores a script's first line).
- Recording is best effort: if the journal cannot be written, stderr carries one `{"warning": ...}` line and the command still runs, so the printed ID may be the only handle. Judge the command by stdout and the exit code, not by stderr being non-empty.
- `recent [--limit n] [--pid <PID>]` lists recorded jobs, newest first, without contacting Blender. States are the last ones this machine saw.
- `status|wait|cancel <id>` without a target reuses the recorded endpoint. Whenever the job's session is recorded, the CLI compares it with the live Blender: an implicit target (journal or `BLENDER_BRIDGE_URL`) in another session exits 2, because Blender's in-memory job records did not survive the restart; an explicit `--url`/`--pid` answers with a warning and does not touch the record. An unreadable journal asks for an explicit target. A reused ID in the same session is the same job: a refused resubmission or a failed query never rewrites its record.
- Concurrent CLI processes serialise appends and compaction through a lock file. Past 1 MiB the journal is compacted to one complete snapshot per job, keeping the newest 2000 or 512 KiB.
- `--max-chars <n>` shortens each printed text field and the logs (newest lines first; an oversized line keeps its end) and reports what was cut in `truncated`; Blender's record is unaffected.
- Job submissions query health first, so an endpoint that does not answer is rejected before an ID is issued. The CLI needs Node 22+ and says so when started on older Node.
- The DSH adapter keeps its own job handling; it does not read or write this journal.

## Validate

```text
npm test
blender --factory-startup --python tests/bootstrap_gui.py
node tests/smoke.mjs http://127.0.0.1:<isolated-port>
node tests/screenshot-smoke.mjs http://127.0.0.1:<isolated-port> <empty-evidence-directory>
```

Run smoke tests only in the disposable instance. See [AGENTS.md](AGENTS.md) for maintenance invariants.
