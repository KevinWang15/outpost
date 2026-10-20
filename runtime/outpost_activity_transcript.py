"""Incremental native transcript index shared by list and terminal observers.

Only event state, timestamp, offsets and integrity anchors are persisted. Cold
reads walk backwards to a marker; append reads never discard an earlier marker
just because a turn produced lots of output.
"""

import datetime
import os

from outpost_activity_events import STATES, file_lock, read_json, write_json
from outpost_activity_state import checkpoint, covered

BLOCK = 64 * 1024
MAX_RECORD = 16 * 1024 * 1024
BATCH = 4 * 1024 * 1024


def timestamp(value):
    try:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return datetime.datetime.fromtimestamp(value / 1000, datetime.timezone.utc).isoformat()
        if isinstance(value, str):
            parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
            if parsed.tzinfo:
                return parsed.astimezone(datetime.timezone.utc).isoformat()
    except (ValueError, OverflowError, OSError):
        pass
    return None


def decode(line):
    import json

    try:
        value = json.loads(line)
        return value if isinstance(value, dict) else None
    except (ValueError, UnicodeDecodeError, RecursionError):
        return None


def complete_size(stream, size):
    position = size
    while position:
        count = min(position, BLOCK)
        position -= count
        stream.seek(position)
        data = stream.read(count)
        index = data.rfind(b'\n')
        if index >= 0:
            return position + index + 1
        if size - position > MAX_RECORD:
            raise ValueError('An incomplete native transcript record exceeds 16 MiB.')
    return 0


def reverse_records(stream, size):
    """Bound memory, not the distance to the last lifecycle event."""
    position = complete_size(stream, size)
    end = position
    buffer = b''
    while position:
        count = min(position, BLOCK)
        position -= count
        stream.seek(position)
        buffer = stream.read(count) + buffer
        if len(buffer) > MAX_RECORD + BLOCK:
            raise ValueError('A native transcript record exceeds 16 MiB.')
        while buffer:
            separator = buffer[:-1].rfind(b'\n')
            if separator < 0 and position:
                break
            line = buffer[separator + 1 :]
            buffer = buffer[: separator + 1]
            offset = end
            end -= len(line)
            record = decode(line)
            if record is not None:
                yield record, offset


def read_cache(path):
    try:
        cache = read_json(path)
    except ValueError:
        return None  # Derived data is disposable; native records are authoritative.
    if not isinstance(cache, dict) or type(cache.get('size')) is not int or type(cache.get('mtime')) is not int:
        return None
    selected = cache.get('marker')
    if selected is not None and not (
        isinstance(selected, list)
        and len(selected) == 2
        and isinstance(selected[0], list)
        and len(selected[0]) == 2
        and selected[0][0] in STATES
        and type(selected[1]) is int
        and 0 <= selected[1] <= cache['size']
        and (selected[0][1] is None or isinstance(selected[0][1], (str, int, float)))
    ):
        return None
    return cache


def marker(directory, session_id, adapter, path):
    cache_path = directory / (session_id + '.transcript.json')
    with file_lock(directory / (session_id + '.transcript.lock')):
        with path.open('rb') as stream:
            info = os.fstat(stream.fileno())
            cache = read_cache(cache_path)
            if (
                not isinstance(cache, dict)
                or cache.get('path') != str(path)
                or (cache['size'] == info.st_size and cache['mtime'] != info.st_mtime_ns)
                or not covered(cache.get('end'), stream, info, 0)
            ):
                selected = adapter.activity_marker(reverse_records(stream, info.st_size))
                end = complete_size(stream, info.st_size)
            else:
                selected = cache['marker']
                end = cache['end']['offset']
                stream.seek(end)
                consumed = 0
                while end < info.st_size and consumed < BATCH:
                    line = stream.readline(MAX_RECORD + 1)
                    if len(line) > MAX_RECORD:
                        raise ValueError('A native transcript record exceeds 16 MiB.')
                    if not line.endswith(b'\n'):
                        break
                    end += len(line)
                    consumed += len(line)
                    record = decode(line)
                    if record is not None:
                        selected = adapter.activity_update(
                            record, end, selected, lambda end=end: reverse_records(stream, end)
                        )
                        stream.seek(end)
                if end == cache['end']['offset']:
                    return observation(stream, info, selected)
            write_json(
                cache_path,
                {
                    'path': str(path),
                    'end': checkpoint(stream, info, end),
                    'marker': selected,
                    'size': info.st_size,
                    'mtime': info.st_mtime_ns,
                },
            )
            if end < complete_size(stream, info.st_size):
                raise ValueError('Catching up with native activity records.')
            return observation(stream, info, selected)


def observation(stream, info, selected):
    # Carry the file identity with the selected marker. A replacement between
    # this read and acknowledgement must never receive the old file's offset.
    return (selected[0], checkpoint(stream, info, selected[1])) if selected else None
