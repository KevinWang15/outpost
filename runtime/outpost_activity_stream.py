"""Publish the list's native activity state without blocking terminal I/O."""

import time
from concurrent.futures import ThreadPoolExecutor

from outpost_activity import unavailable

INTERVAL = 2


class ActivityStream:
    def __init__(self, read):
        self.read = read
        self.worker = None
        self.future = None
        self.next_read = 0
        self.last = None

    def poll(self):
        """One in-flight observation; return only changes, including failed reads."""
        changed = None
        if self.future is not None and self.future.done():
            try:
                state = self.future.result()
            except Exception as error:
                # Optional metadata must never break a live terminal connection.
                state = unavailable(error)
            self.future = None
            self.next_read = time.monotonic() + INTERVAL
            if state != self.last:
                self.last = changed = state
        if self.future is None and time.monotonic() >= self.next_read:
            if self.worker is None:
                # poll() runs after pty.fork(), just like the history worker.
                self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix='outpost-activity')
            self.future = self.worker.submit(self.read)
        return changed

    def close(self):
        if self.worker:
            self.worker.shutdown(wait=False, cancel_futures=True)
