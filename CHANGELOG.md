# Changelog

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
