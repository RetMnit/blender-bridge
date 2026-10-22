"""Agent-neutral Blender HTTP bridge. bpy work runs only on the main thread."""
import collections
import contextlib
import hashlib
import http.server
import inspect
import io
import json
import os
from pathlib import Path
import re
import socket
import sys
import tempfile
import threading
import time
import traceback
import uuid

import bpy

VERSION = "0.3.0"
TERMINAL = {"succeeded", "failed", "cancelled", "expired", "interrupted"}
DISCOVERY = Path(tempfile.gettempdir()) / "blender-bridge"
MAX_BODY = 1024 * 1024
MAX_JOBS = 128


def stringify(value):
    try:
        return value if isinstance(value, str) else str(value)
    except Exception:
        return "<unprintable>"


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_json(self, status, data):
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def allowed(self):
        # Local CLI clients have no Origin. Do not let an arbitrary web page run Python.
        host = self.headers.get("Host", "").split(":")[0]
        if self.headers.get("Origin") or host not in {"127.0.0.1", "localhost"}:
            self.send_json(403, {"error": "local non-browser clients only"})
            return False
        return True

    def do_GET(self):
        if not self.allowed():
            return
        bridge = self.server.bridge
        if self.path == "/api/health":
            self.send_json(200, dict(bridge.health))
        elif self.path.startswith("/api/jobs/"):
            job = bridge.snapshot(self.path.removeprefix("/api/jobs/"))
            self.send_json(200 if job else 404, job or {"error": "unknown/evicted job; inspect scene before retry"})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if not self.allowed():
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY:
                raise ValueError("body must be 1..1048576 bytes")
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(data, dict):
                raise ValueError("expected JSON object")
            bridge = self.server.bridge
            if self.path.startswith("/api/jobs/") and self.path.endswith("/cancel"):
                job_id = self.path[len("/api/jobs/"):-len("/cancel")]
                job = bridge.cancel(job_id)
                self.send_json(200 if job else 404, job or {"error": "unknown job"})
                return
            if self.path not in {"/api/jobs", "/api/execute"}:
                self.send_json(404, {"error": "not found"})
                return
            job, created = bridge.submit(data)
            if self.path == "/api/jobs":
                self.send_json(202 if created else 200, bridge.snapshot(job["id"]))
                return
            # Compatibility endpoint retains result/logs/error. A timeout includes the ID.
            job["done"].wait(30)
            snap = bridge.snapshot(job["id"])
            if snap["status"] == "succeeded":
                self.send_json(200, {"id": job["id"], "result": snap["result"], "logs": snap["logs"]})
            else:
                self.send_json(500 if snap["status"] in TERMINAL else 202, dict(snap, error=snap.get("error") or "still running; query job ID; do not resubmit"))
        except ValueError as exc:
            self.send_json(400, {"error": str(exc)})
        except Conflict as exc:
            self.send_json(409, {"error": str(exc)})
        except Busy as exc:
            self.send_json(503, {"error": str(exc)})


class Conflict(Exception):
    pass


class Busy(Exception):
    pass


class HTTPServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def server_bind(self):
        # HTTPServer's SO_REUSEADDR permits two Windows processes on one port.
        # Discovery must always address exactly one Blender instance.
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class Bridge:
    def __init__(self):
        self.lock = threading.RLock()
        self.jobs = collections.OrderedDict()
        self.queue = collections.deque()
        self.active = None
        self.httpd = None
        self.thread = None
        self.enabled = False
        self.descriptor = None
        self.health = {}
        self.session = str(uuid.uuid4())
        self.timer_callback = self.poll
        self.last_status = "Ready"

    @property
    def running(self):
        return self.thread is not None and self.thread.is_alive()

    def update_health(self):
        self.health = {"ok": True, "bridge": VERSION, "protocol": 2,
                       "blender": bpy.app.version_string, "python": sys.version.split()[0],
                       "pid": os.getpid(), "session": self.session,
                       "file": bpy.data.filepath, "background": bpy.app.background,
                       "url": "http://127.0.0.1:%s" % self.httpd.server_port if self.httpd else ""}

    def start(self, port=6418):
        self.enabled = True
        if self.running:
            return
        for candidate in (port, 0):
            try:
                self.httpd = HTTPServer(("127.0.0.1", candidate), Handler)
                break
            except OSError:
                if candidate == 0:
                    raise
        self.httpd.bridge = self
        self.update_health()
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True, name="blender-bridge-http")
        self.thread.start()
        if not bpy.app.timers.is_registered(self.timer_callback):
            bpy.app.timers.register(self.timer_callback, first_interval=0.1, persistent=True)
        DISCOVERY.mkdir(exist_ok=True)
        self.descriptor = DISCOVERY / ("%s.json" % os.getpid())
        self.write_descriptor()
        print("[BlenderBridge] " + self.health["url"])

    def write_descriptor(self):
        if self.descriptor:
            temp = self.descriptor.with_suffix(".tmp")
            temp.write_text(json.dumps(self.health), encoding="utf-8")
            temp.replace(self.descriptor)

    def stop(self):
        self.enabled = False
        if bpy.app.timers.is_registered(self.timer_callback):
            bpy.app.timers.unregister(self.timer_callback)
        # Close outside the lock, on the main thread, so screenshot finally blocks
        # restore a temporarily exposed window on stop/load as well as cancel.
        if self.active and self.active["generator"]:
            try:
                self.active["generator"].close()
            except BaseException:
                traceback.print_exc()
            self.active["generator"] = None
        with self.lock:
            for job in self.jobs.values():
                if job["status"] not in TERMINAL:
                    self.finish(job, "interrupted", "bridge stopped; inspect scene before retry")
            self.queue.clear()
            self.active = None
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()
        self.httpd = self.thread = None
        if self.descriptor:
            self.descriptor.unlink(missing_ok=True)
        self.descriptor = None

    def submit(self, data):
        code = data.get("code")
        job_id = data.get("id", str(uuid.uuid4()))
        if not isinstance(code, str) or not code.strip():
            raise ValueError("empty code")
        if not isinstance(job_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", job_id):
            raise ValueError("invalid id")
        try:
            interval, ttl = float(data.get("interval", 0.2)), float(data.get("ttl", 30))
        except (TypeError, ValueError):
            raise ValueError("invalid interval/ttl")
        if not 0.05 <= interval <= 10 or not 1 <= ttl <= 3600:
            raise ValueError("interval: 0.05..10 seconds; ttl: 1..3600 seconds")
        digest = hashlib.sha256(json.dumps([code, interval, ttl]).encode()).hexdigest()
        with self.lock:
            old = self.jobs.get(job_id)
            if old:
                if old["digest"] != digest:
                    raise Conflict("same ID with different payload")
                return old, False
            if not self.running:
                raise Busy("bridge stopped")
            while len(self.jobs) >= MAX_JOBS:
                oldest = next((key for key, job in self.jobs.items() if job["status"] in TERMINAL), None)
                if oldest is None:
                    raise Busy("job history full of pending work")
                del self.jobs[oldest]
            job = {"id": job_id, "code": code, "digest": digest, "status": "queued",
                   "interval": interval, "created": time.time(), "expires": time.monotonic() + ttl,
                   "logs": [], "result": "", "error": "", "progress": "", "steps": 0,
                   "generator": None, "cancel": False, "done": threading.Event()}
            self.jobs[job_id] = job
            self.queue.append(job_id)
            return job, True

    def snapshot(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            return {key: (list(job[key]) if key == "logs" else job[key]) for key in
                    ("id", "status", "created", "logs", "result", "error", "progress", "steps")} if job else None

    def cancel(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            if job and job["status"] not in TERMINAL:
                if job["status"] == "queued":
                    self.finish(job, "cancelled")
                else:
                    job["cancel"] = True  # observed only between generator steps
            return self.snapshot(job_id)

    def finish(self, job, status, error=""):
        with self.lock:
            if job["status"] in TERMINAL:
                return
            job["status"], job["error"] = status, error
            job["done"].set()
        self.last_status = "%s: %s (%s steps)" % (job["id"][:8], status, job["steps"])

    def redraw(self):
        for window in bpy.context.window_manager.windows:
            for area in window.screen.areas:
                area.tag_redraw()

    def advance(self, job):
        out = io.StringIO()
        completion = None
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
                if job["generator"] is None:
                    import mathutils
                    globs = {"bpy": bpy, "C": bpy.context, "D": bpy.data, "context": bpy.context,
                             "mathutils": mathutils, "__name__": "__bridge_execute__"}
                    source = "def __bridge_main():\n" + "\n".join("    " + line for line in job["code"].splitlines())
                    exec(compile(source, "<blender_bridge>", "exec"), globs)
                    value = globs["__bridge_main"]()
                    if inspect.isgenerator(value):
                        job["generator"] = value
                    else:
                        job["result"] = stringify(value)
                        completion = ("succeeded", "")
                        return
                value = next(job["generator"])
                with self.lock:
                    job["progress"] = stringify(value)[:8192]
                    job["steps"] += 1
                self.last_status = "%s: step %s — %s" % (job["id"][:8], job["steps"], job["progress"][:100])
        except StopIteration as stop:
            job["result"] = stringify(stop.value)
            completion = ("succeeded", "")
        except BaseException:
            completion = ("failed", traceback.format_exc())
        finally:
            with self.lock:
                job["logs"].extend(out.getvalue().splitlines())
                job["logs"] = job["logs"][-1000:]
                if completion:
                    self.finish(job, *completion)
            self.redraw()

    def poll(self):
        # One generator step OR one short command per callback: always yield to GUI.
        if not self.enabled:
            return None
        previous_file = self.health.get("file")
        self.update_health()
        if previous_file != self.health["file"]:
            self.write_descriptor()
        with self.lock:
            if self.active is None:
                while self.queue:
                    job = self.jobs.get(self.queue.popleft())
                    if job is None or job["status"] != "queued":
                        continue
                    if time.monotonic() >= job["expires"]:
                        self.finish(job, "expired", "queue TTL expired; code did not execute")
                        continue
                    job["status"] = "running"
                    self.active = job
                    break
            job = self.active
        if job:
            if job["cancel"]:
                try:
                    if job["generator"]:
                        job["generator"].close()
                    self.finish(job, "cancelled", "cancelled between steps; prior steps remain")
                except BaseException:
                    self.finish(job, "failed", traceback.format_exc())
            else:
                self.advance(job)
            interval = job["interval"]
            if job["status"] in TERMINAL:
                job["generator"] = None
                self.active = None
            return interval
        return 0.1


bridge = Bridge()
