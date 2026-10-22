# Protocol 2 (bridge 0.3.0)

All endpoints are loopback HTTP, JSON UTF-8. Reject browser Origin requests and nonlocal Host headers. Maximum request body 1 MiB. Trusted local processes can execute arbitrary Python; this is not a network authentication system.

| Request | Meaning |
|---|---|
| `GET /api/health` | Cached main-thread metadata: version, protocol, PID, session UUID, Blender version, background flag, file, endpoint |
| `POST /api/jobs` | `{id?,code,interval?:0.2,ttl?:30}` → 202 new / 200 same-ID same-payload; 409 conflict; 503 capacity/stopped |
| `GET /api/jobs/<id>` | Snapshot; 404 unknown/evicted. Inspect scene before retrying unknown writes |
| `POST /api/jobs/<id>/cancel` | JSON `{}`; queued cancellation prevents execution, running generator stops at next boundary |
| `POST /api/execute` | Legacy code request, waits up to 30s: 200 `{id,result,logs}`, failed 500 `{id,status,error,...}`, still running 202 includes ID/status/error |

ID is 1–100 ASCII letters/digits/underscore/hyphen. interval 0.05–10 seconds; queue ttl 1–3600 seconds. Same-ID fingerprint includes exact code, interval and TTL. The record includes `id,status,created,logs,result,error,progress,steps`. Status: queued/running/succeeded/failed/cancelled/expired/interrupted. Result/progress are display strings; last 1000 output lines retained; progress limited to 8192 characters. Logs may be produced on errors too.

The main-thread timer executes at most one command/generator step per tick. A function-body snippet returns normally or becomes a generator when it contains yield. Each generator yield records progress and lets the GUI redraw; its final return becomes result. Exceptions produce failed with traceback. Exception or cancellation does not roll back bpy mutations; generator cleanup can also mutate state. Running synchronous work cannot be preempted.

Job records are in memory, bounded at 128. Terminal records are evicted first; if all are pending reject new work. Never replay automatically. Deduplication does not survive addon/Blender restart; inspect health.session to detect restart. A queue TTL only expires work before starting. Stopping the addon or loading a file marks pending work interrupted. No durable execution guarantee is claimed.

Discovery files are `<OS-temp>/blender-bridge/<pid>.json`. Verify live health PID and session; ignore stale or mismatched descriptors. Fixed port 6418 is only a preference; use the endpoint from the selected descriptor. Multiple instances use distinct ports. No bpy API is accessed from HTTP worker threads.

## Validated screenshots (addon 0.3.0+)

The shared client's `screenshotCode(output)` builds a regular protocol-2 generator job invoking `blender_bridge.screenshot.capture`; `submitScreenshot(base,output,options)` submits it. There is no new HTTP endpoint. CLI `screenshot` and DSH `blender_bridge` action `screenshot` use this identical body, so the existing ID/deduplication/wait/cancel rules apply. Output must be an absolute new `.png` path whose parent exists.

On Windows the helper resolves a native window owned by the current PID, preferring client dimensions matching the largest bpy window; ambiguity fails without touching other processes. A minimized target is restored, allowed two event-loop redraw ticks, captured with the matching bpy context and returned to minimized state in a `finally` block. Cancellation and bridge Stop close the generator to run cleanup. Other platforms capture GUI windows without automatic restoration. Background mode is rejected.

The PNG is first written to a temporary sibling file. Loaded RGB pixels (excluding alpha) must have a maximum greater than 1/255; otherwise the job fails and the temporary file is removed. A valid PNG is published without overwriting any existing target, even if it appeared during capture. Result is a JSON-encoded string containing `path,width,height,validated,restored_minimized,max_rgb,mean_rgb`. It detects black frames, not every incorrect or stale image; clients should still view the PNG. No scene, layout or blend save is performed.
