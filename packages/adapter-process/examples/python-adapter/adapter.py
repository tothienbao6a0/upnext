#!/usr/bin/env python3
"""A complete audio backend in one file, in a language the core knows nothing about.

Run it through ProcessAdapter and the runtime cannot tell it apart from an
adapter written in TypeScript: it declares capabilities, resolves refs, plays,
and pushes an event when a track ends.

    adapter = ProcessAdapter({
      id: 'python',
      command: 'python3',
      args: ['examples/python-adapter/adapter.py'],
    })

Protocol: one JSON object per line, both directions.
  in   {"id": 1, "method": "resolve", "params": {"ref": {...}}}
  out  {"id": 1, "result": {...}}            replies
  out  {"event": {"type": "ended"}}          unsolicited
"""

import json
import os
import shutil
import subprocess
import sys
import threading
import time
from urllib.parse import unquote, urlparse

WRITE_LOCK = threading.Lock()


def send(payload):
    """stdout is the protocol channel, so nothing else may ever be written to it."""
    with WRITE_LOCK:
        sys.stdout.write(json.dumps(payload) + "\n")
        sys.stdout.flush()


def log(message):
    sys.stderr.write("[python-adapter] %s\n" % message)
    sys.stderr.flush()


class Backend:
    def __init__(self, silent=False, simulated_duration_ms=1000):
        self.silent = silent
        self.simulated_duration_ms = simulated_duration_ms
        self.player = shutil.which("ffplay") or shutil.which("afplay")
        self.process = None
        self.target = None
        self.started_at = None
        self.generation = 0

    # -- protocol methods --------------------------------------------------

    def init(self, _params):
        return {
            "capabilities": {
                "endOfTrack": "event",
                "position": "estimated",
                "pause": not self.silent,
                "search": False,
            },
            "schemes": ["file://", "/"],
            "schemeScore": 0.9,
            "matchesTitles": False,
        }

    def resolve(self, params):
        ref = params.get("ref", {})
        uri = ref.get("uri")
        if not uri:
            return None
        path = to_path(uri)
        if not os.path.isfile(path):
            return None
        return {
            "adapterId": "python",
            "nativeUri": path,
            "ref": {
                **ref,
                "title": ref.get("title") or os.path.splitext(os.path.basename(path))[0],
                "durationMs": ref.get("durationMs") or self.simulated_duration_ms,
            },
        }

    def load(self, params):
        self.stop({})
        binding = params.get("binding", {})
        self.target = binding.get("nativeUri")
        return None

    def play(self, _params):
        if not self.target:
            raise ValueError("nothing loaded")
        self.generation += 1
        generation = self.generation
        self.started_at = time.time()

        if self.silent or not self.player:
            # No audio device involved: still a real backend as far as the
            # runtime is concerned, which is what makes this testable.
            threading.Timer(
                self.simulated_duration_ms / 1000.0,
                lambda: self._ended(generation),
            ).start()
            return None

        args = [self.player, "-nodisp", "-autoexit", "-loglevel", "error", self.target]
        if self.player.endswith("afplay"):
            args = [self.player, self.target]
        self.process = subprocess.Popen(args)
        threading.Thread(target=self._wait, args=(self.process, generation), daemon=True).start()
        return None

    def pause(self, _params):
        if self.process:
            self.process.send_signal(19)  # SIGSTOP
        return None

    def stop(self, _params):
        self.generation += 1  # Anything already in flight is now stale.
        if self.process:
            try:
                self.process.send_signal(18)  # SIGCONT, so SIGKILL can land
                self.process.kill()
            except Exception:
                pass
            self.process = None
        return None

    def poll(self, _params):
        elapsed = int((time.time() - self.started_at) * 1000) if self.started_at else 0
        return {
            "status": "playing" if self.process or self.started_at else "idle",
            "positionMs": elapsed,
            "nativeUri": self.target,
        }

    # -- internals ---------------------------------------------------------

    def _wait(self, process, generation):
        process.wait()
        if generation == self.generation:
            self._ended(generation)

    def _ended(self, generation):
        if generation != self.generation:
            return  # Superseded by a stop or a newer track.
        self.process = None
        send({"event": {"type": "ended"}})


def to_path(uri):
    if uri.startswith("file://"):
        return unquote(urlparse(uri).path)
    return uri


def main():
    silent = "--silent" in sys.argv
    duration = 1000
    if "--duration-ms" in sys.argv:
        duration = int(sys.argv[sys.argv.index("--duration-ms") + 1])

    backend = Backend(silent=silent, simulated_duration_ms=duration)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            log("ignoring unparseable line")
            continue

        handler = getattr(backend, message.get("method", ""), None)
        if handler is None:
            send({"id": message.get("id"), "error": {"code": "unknown_method",
                                                     "message": message.get("method", "")}})
            continue
        try:
            send({"id": message["id"], "result": handler(message.get("params") or {})})
        except Exception as err:  # noqa: BLE001 - report, never die
            send({"id": message["id"], "error": {"code": "adapter_error", "message": str(err)}})


if __name__ == "__main__":
    main()
