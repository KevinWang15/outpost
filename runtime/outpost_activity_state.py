"""Target-owned acknowledgement checkpoints; never persist terminal input or transcripts."""

import fcntl
import hashlib
import json
import os
import re
import tempfile
import time
import uuid
from contextlib import contextmanager

from outpost_activity_events import STATES, file_lock, read_json, write_json

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


def valid_checkpoint(point):
    return (
        isinstance(point, dict)
        and set(point) == {'source', 'offset', 'anchor'}
        and isinstance(point['source'], str)
        and re.fullmatch(r'\d+:\d+', point['source'])
        and type(point['offset']) is int
        and point['offset'] >= 0
        and isinstance(point['anchor'], str)
        and re.fullmatch(r'[0-9a-f]{64}', point['anchor'])
    )


def covered(point, stream, info, offset):
    if (
        not valid_checkpoint(point)
        or point['source'] != source_key(info)
        or not offset <= point['offset'] <= info.st_size
    ):
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

    def events(self):
        value = read_json(self.directory / (self.session['id'] + '.events.json'))
        if value is not None and (
            not isinstance(value, dict)
            or not self.adapter.valid_id(value.get('session'))
            or not isinstance(value.get('generation'), str)
            or type(value.get('received')) is not int
            or value.get('state') not in (*STATES, None)
            or type(value.get('observed')) is not bool
        ):
            raise ValueError('Invalid activity lifecycle metadata.')
        return value

    def selected_session(self):
        events = self.events()
        return {**self.session, 'cliSessionId': events['session']} if events else self.session

    def begin_launch(self, executable):
        generation = uuid.uuid4().hex
        path = self.directory / (self.session['id'] + '.events.json')
        with file_lock(self.directory / (self.session['id'] + '.events.lock')):
            write_json(
                path,
                {
                    'generation': generation,
                    'session': self.session['cliSessionId'],
                    'state': None,
                    'turn': None,
                    'received': time.time_ns(),
                    'observed': False,
                    'event': None,
                    'error': None,
                },
            )
        try:
            arguments = self.adapter.prepare_activity(self.directory, self.session, generation, executable)
        except (OSError, ValueError) as error:
            # Optional activity integration must never make a terminal unusable.
            with file_lock(self.directory / (self.session['id'] + '.events.lock')):
                value = read_json(path)
                value['error'] = str(error)[:2000]
                write_json(path, value)
            arguments = []
        return generation, arguments

    def event_seen(self, token):
        return token in self.seen_events()

    def seen_events(self):
        seen = read_json(self.directory / (self.session['id'] + '.seen.json')) or []
        if (
            not isinstance(seen, list)
            or len(seen) > 64
            or any(not isinstance(token, str) or not re.fullmatch(r'[0-9a-f]{64}', token) for token in seen)
        ):
            raise ValueError('Invalid activity acknowledgement.')
        return seen

    def see_event(self, token):
        path = self.directory / (self.session['id'] + '.seen.json')
        with file_lock(self.directory / (self.session['id'] + '.seen.lock')):
            seen = self.seen_events()
            if token not in seen:
                write_json(path, [*seen[-63:], token])

    def read(self):
        data = read_json(self.path, limit=8192)
        if not isinstance(data, dict) or set(data) != {'baseline', 'checked'}:
            raise ValueError('Invalid activity metadata; expected the current schema.')
        for point in data.values():
            if point is not None and not valid_checkpoint(point):
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
        found = latest_file(self.adapter, self.selected_session())
        if found is None:
            return None
        with found[0].open('rb') as stream:
            info = os.fstat(stream.fileno())
            return checkpoint(stream, info, info.st_size)

    def initialize(self):
        with self.lock():
            try:
                point = self.snapshot()
            except (OSError, ValueError):
                # Optional activity discovery must not prevent the PTY starting.
                # The normal observer reports any ongoing discovery failure.
                point = None
            self.save({'baseline': point, 'checked': point})
        for suffix in ('observation.json', 'transcript.json'):
            (self.directory / (self.session['id'] + '.' + suffix)).unlink(missing_ok=True)

    def describe(self, running):
        from outpost_activity import describe

        return describe(self, running)

    def acknowledge(self, token, running):
        from outpost_activity import acknowledge

        acknowledge(self, token, running)

    def input(self):
        # Only an offset and checksum are saved. Keystrokes never enter metadata.
        from outpost_activity import event_token

        events = self.events()
        if events and events.get('state') == 'finished':
            self.see_event(event_token(events))
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
        for suffix in (
            'events.json',
            'events.lock',
            'seen.json',
            'seen.lock',
            'observation.json',
            'observation.lock',
            'transcript.json',
            'transcript.lock',
        ):
            (self.directory / (self.session['id'] + '.' + suffix)).unlink(missing_ok=True)
