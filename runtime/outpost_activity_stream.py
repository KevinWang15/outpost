"""Publish the list's native activity state without blocking terminal I/O."""

import time
from collections import deque
from threading import Event, Lock, Thread

from outpost_activity import stale, unavailable
from outpost_activity_watch import ActivityWatch

INTERVAL = 2
READ_TIMEOUT = 5


class ActivityStream:
    def __init__(self, read, acknowledge, path=None):
        self.read = read
        self.acknowledge = acknowledge
        self.worker = None
        self.stopped = Event()
        self.wakeup = Event()
        self.lock = Lock()
        self.requests = deque()
        self.results = deque()
        self.pending = 0
        self.read_started = None
        self.result = None
        self.retry_at = 0
        self.last = None
        self.watch = ActivityWatch(path) if path is not None else None

    def observe(self):
        reconcile_at = time.monotonic() + INTERVAL
        while not self.stopped.is_set():
            self.wakeup.clear()
            with self.lock:
                self.read_started = time.monotonic()
                requests = list(self.requests)
                self.requests.clear()
            results = []
            for identifier, completion_id in requests:
                try:
                    self.acknowledge(completion_id)
                    results.append({'type': 'result', 'id': identifier, 'ok': True})
                except Exception as error:
                    results.append({'type': 'result', 'id': identifier, 'ok': False, 'message': str(error)[:4000]})
            try:
                reconcile = time.monotonic() >= reconcile_at
                state = self.read(reconcile=reconcile)
                if reconcile:
                    reconcile_at = time.monotonic() + INTERVAL
            except Exception as error:
                # Optional metadata must never break a live terminal connection.
                state = stale(self.result, error)
                reconcile_at = time.monotonic() + INTERVAL
            with self.lock:
                self.result = state
                self.results.extend(results)
                self.read_started = None
            self.wakeup.wait(max(0, reconcile_at - time.monotonic()))

    def request_acknowledgement(self, identifier, completion_id):
        # Include in-flight and undelivered requests in the bound. A stalled
        # filesystem must not accumulate work or block terminal input/output.
        with self.lock:
            if self.stopped.is_set() or self.pending >= 32:
                return False
            self.pending += 1
            self.requests.append((identifier, completion_id))
        self.wakeup.set()
        return True

    def take_results(self):
        with self.lock:
            results = list(self.results)
            self.results.clear()
            self.pending -= len(results)
        return results

    def poll(self):
        """One reader and one latest-result slot, even while output is backed up."""
        if self.stopped.is_set():
            return None
        if self.watch is not None and self.watch.changed():
            self.wakeup.set()
        now = time.monotonic()
        if self.worker is None and now >= self.retry_at:
            try:
                # A stuck filesystem read must not keep
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
                state = stale(self.result, 'Reading native activity timed out.')

        # Freshness timestamps advance on every successful observation. Send
        # meaningful changes only; a later failure carries the latest timestamp.
        def signature(value):
            return {key: item for key, item in value.items() if key != 'observedAt'} if value else None

        if state is not None and signature(state) != signature(self.last):
            self.last = state
            return state
        return None

    def close(self):
        self.stopped.set()
        self.wakeup.set()
        if self.watch is not None:
            self.watch.close()
