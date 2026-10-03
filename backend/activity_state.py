"""Target-owned acknowledgement checkpoints; never persist terminal input or transcripts."""
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
import re
import tempfile
import time

MAX_PATHS = 4096


def latest_file(adapter, session):
    """Match the pinned store and native ID; never scan unrelated conversations."""
    home = adapter.home(session['cliSessionEnv'], session['rootDir'])
    deadline = time.monotonic() + 2
    found = None
    for index, path in enumerate(adapter.activity_files(session)):
        if index >= MAX_PATHS or time.monotonic() > deadline:
            raise ValueError('Native activity file discovery exceeded its limit.')
        if path.is_symlink() or not path.resolve().is_relative_to(home):
            continue
        try:
            info = path.stat()
            if path.is_file() and (found is None or info.st_mtime_ns > found[1].st_mtime_ns):
                found = (path, info)
        except FileNotFoundError:
            continue
    return found


def source_key(info):
    return str(info.st_dev) + ':' + str(info.st_ino)


def checkpoint(stream, info, offset):
    stream.seek(max(0, offset - 128))
    anchor = hashlib.sha256(stream.read(min(128, offset))).hexdigest()
    return {'source': source_key(info), 'offset': offset, 'anchor': anchor}


def covered(point, stream, info, offset):
    if point is None or point['source'] != source_key(info) or not offset <= point['offset'] <= info.st_size:
        return False
    # A rewritten or truncated transcript must not inherit an old byte watermark.
    return checkpoint(stream, info, point['offset']) == point


class Activity:
    """Target-owned check state shared by browsers and terminal connections."""
    def __init__(self, directory, adapter, session):
        self.directory = directory
        self.adapter = adapter
        self.session = session
        self.path = directory / (session['id'] + '.json')
        self.last_input = None

    def read(self):
        with self.path.open('rb') as stream:
            raw = stream.read(8193)
        if len(raw) > 8192:
            raise ValueError('Activity metadata exceeds its size limit.')
        data = json.loads(raw)
        if not isinstance(data, dict) or set(data) != {'baseline', 'checked'}:
            raise ValueError('Invalid activity metadata; expected the current schema.')
        for point in data.values():
            if point is not None and (not isinstance(point, dict) or set(point) != {'source', 'offset', 'anchor'}
                                      or not isinstance(point['source'], str) or not re.fullmatch(r'\d+:\d+', point['source'])
                                      or type(point['offset']) is not int or point['offset'] < 0
                                      or not isinstance(point['anchor'], str) or not re.fullmatch(r'[0-9a-f]{64}', point['anchor'])):
                raise ValueError('Invalid activity acknowledgement.')
        return data

    @contextmanager
    def lock(self):
        self.directory.mkdir(mode=0o700, exist_ok=True)
        with (self.directory / (self.session['id'] + '.lock')).open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            yield

    def save(self, data):
        descriptor, temporary = tempfile.mkstemp(prefix='.activity-', dir=self.directory)
        try:
            with os.fdopen(descriptor, 'w') as stream:
                json.dump(data, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def snapshot(self):
        found = latest_file(self.adapter, self.session)
        if found is None:
            return None
        with found[0].open('rb') as stream:
            info = os.fstat(stream.fileno())
            return checkpoint(stream, info, info.st_size)

    def initialize(self):
        with self.lock():
            point = self.snapshot()
            self.save({'baseline': point, 'checked': point})

    def describe(self, running):
        from outpost_coding_activity import describe
        return describe(self, running)

    def acknowledge(self, token, running):
        from outpost_coding_activity import acknowledge
        acknowledge(self, token, running)

    def input(self):
        # Only an offset and checksum are saved. Keystrokes never enter metadata.
        with self.lock():
            # Capture the watermark under the same lock as browser checks and
            # other terminals, so an older input cannot undo a newer check.
            point = self.snapshot()
            if point == self.last_input:
                return
            metadata = self.read()
            metadata['checked'] = point
            self.save(metadata)
        self.last_input = point

    def remove(self):
        self.path.unlink(missing_ok=True)
        (self.directory / (self.session['id'] + '.lock')).unlink(missing_ok=True)
