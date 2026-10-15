"""Publish the list's native activity state without blocking terminal I/O."""

import time
from threading import Event, Lock, Thread

from outpost_activity import unavailable

INTERVAL = 2
READ_TIMEOUT = 5


class ActivityStream:
    def __init__(self, read):
        self.read = read
        self.worker = None
        self.stopped = Event()
        self.lock = Lock()
        self.read_started = None
        self.result = None
        self.retry_at = 0
        self.last = None

    def observe(self):
        while not self.stopped.is_set():
            with self.lock:
                self.read_started = time.monotonic()
            try:
                state = self.read()
            except Exception as error:
                # Optional metadata must never break a live terminal connection.
                state = unavailable(error)
            with self.lock:
                self.result = state
                self.read_started = None
            if self.stopped.wait(INTERVAL):
                break

    def poll(self):
        """One reader and one latest-result slot, even while output is backed up."""
        if self.stopped.is_set():
            return None
        now = time.monotonic()
        if self.worker is None and now >= self.retry_at:
            try:
                # Starts after pty.fork(). A stuck filesystem read must not keep
                # the relay alive on disconnect; never start a replacement reader.
                worker = Thread(target=self.observe, name='outpost-activity', daemon=True)
                worker.start()
                self.worker = worker
            except RuntimeError as error:
                self.result = unavailable(error)
                self.retry_at = now + INTERVAL
        with self.lock:
            state = self.result
            if self.read_started is not None and now - self.read_started >= READ_TIMEOUT:
                state = unavailable('Reading native activity timed out.')
        if state is not None and state != self.last:
            self.last = state
            return state
        return None

    def close(self):
        self.stopped.set()
