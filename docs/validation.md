# 0.2.0 validation

Verified on Windows with Blender 5.2.0 LTS GUI and bundled Python 3.13.13, using a disposable factory-startup instance.

- Client mock HTTP test: ID preservation, status polling without resubmission, conflict propagation, local-only endpoint validation, expired wait handling.
- Python queue/lifecycle regressions: cancelled/evicted queue entries cannot break the timer, one generator step per tick, Stop remains stopped, distinct listeners and descriptor cleanup.
- Real bpy/HTTP smoke: health, result, logs, exception traceback, same-ID deduplication, payload conflicts, legacy execute, malformed input, browser Origin rejection, timeout/recovery, queue TTL, queued and running-generator cancellation.
- Visual: three separate screenshots after GUI redraw showed a small cube, a tall block, then a new sphere. The same yielded job produced three progress steps.
- Installation: existing preferences loaded, old addon disabled and neutral addon enabled, saved preferences confirmed. Normal GUI startup starts the installed bridge. Startup registration defers scene access until RestrictedData is lifted and survives loading the startup scene.
- Multiple instances: Windows exclusive socket binding gives each Blender a distinct port; discovery validates PID/session. CLI refuses ambiguous selection. DSH adapter rejects ambiguous execute, runs on an explicit endpoint and remembers that endpoint for subsequent queries.
- File load: current job becomes interrupted, discovery refreshes, no write is replayed, next command succeeds.

Blender 3.6 is the declared addon minimum, but only 5.2 was exercised here. DSH adapter exports and tool handlers were tested directly; a running DSH Desktop must restart to load changed modules. This release does not claim that unyielding synchronous code is responsive, or that job history survives a process restart.
