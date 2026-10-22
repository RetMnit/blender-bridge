# 0.3.0 validation

Windows / Blender 5.2.0 LTS, disposable factory-startup GUI:

- Normal and minimized captures produce visible 3840×2066 Blender screenshots, RGB maximum 1.0 and mean about 0.236. The PNG was viewed to confirm the cube and editor UI.
- Minimized capture restores the window only during the job, then returns it to minimized state. Scene object names, positions and scales remain identical.
- Cancellation after the first redraw restores minimization and publishes no output. Existing output is rejected with its timestamp/content preserved.
- Two simultaneous Blender processes use distinct endpoints. Capturing the selected minimized instance leaves both instances minimized afterward; the other process is not restored. The DSH adapter's real handler uses the same capture job successfully.
- Python tests cover opaque-black RGB rejection, temporary-file cleanup on GPU/operator error, generator closure cleanup, background rejection and existing-file preservation. Stop closes active generators.
- Client/adapter tests cover shared capture submission, path validation, job IDs, endpoint tracking, wait:false, timeout and lost-response recovery.
- Automatic restoration is implemented for Windows; other OSes and Blender versions were not exercised for this change. Black-frame validation does not prove every pixel is current or the intended view; inspect the image.

## Earlier protocol-2 coverage (0.2.0)

Verified on Windows with Blender 5.2.0 LTS GUI and bundled Python 3.13.13, using a disposable factory-startup instance.

- Client mock HTTP test: ID preservation, status polling without resubmission, conflict propagation, local-only endpoint validation, expired wait handling.
- Python queue/lifecycle regressions: cancelled/evicted queue entries cannot break the timer, one generator step per tick, Stop remains stopped, distinct listeners and descriptor cleanup.
- Real bpy/HTTP smoke: health, result, logs, exception traceback, same-ID deduplication, payload conflicts, legacy execute, malformed input, browser Origin rejection, timeout/recovery, queue TTL, queued and running-generator cancellation.
- Visual: three separate screenshots after GUI redraw showed a small cube, a tall block, then a new sphere. The same yielded job produced three progress steps.
- Installation: existing preferences loaded, old addon disabled and neutral addon enabled, saved preferences confirmed. Normal GUI startup starts the installed bridge. Startup registration defers scene access until RestrictedData is lifted and survives loading the startup scene.
- Multiple instances: Windows exclusive socket binding gives each Blender a distinct port; discovery validates PID/session. CLI refuses ambiguous selection. DSH adapter rejects ambiguous execute, runs on an explicit endpoint and remembers that endpoint for subsequent queries.
- File load: current job becomes interrupted, discovery refreshes, no write is replayed, next command succeeds.

Blender 3.6 is the declared addon minimum, but only 5.2 was exercised here. DSH adapter exports and tool handlers were tested directly; a running DSH Desktop must restart to load changed modules. This release does not claim that unyielding synchronous code is responsive, or that job history survives a process restart.
