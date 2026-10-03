"""Bounded native turn-marker readers; loaded only for management requests."""
import datetime
import hashlib
import json
import os
from outpost_activity_state import latest_file, checkpoint, covered

MAX_TAIL = 4 * 1024 * 1024


def reverse_records(stream, size):
    """Read complete records backwards in small blocks within the tail limit."""
    position, remaining = size, MAX_TAIL
    buffer = b''
    end = size
    trim_partial = True
    while position and remaining:
        count = min(position, remaining, 64 * 1024)
        position -= count
        remaining -= count
        stream.seek(position)
        buffer = stream.read(count) + buffer
        if trim_partial:
            newline = buffer.rfind(b'\n')
            if newline < 0:
                continue
            buffer = buffer[:newline + 1]
            end = position + len(buffer)
            trim_partial = False
        while buffer:
            separator = buffer[:-1].rfind(b'\n')
            if separator < 0 and position:
                break
            line = buffer[separator + 1:]
            offset = end
            end -= len(line)
            buffer = buffer[:separator + 1]
            try:
                record = json.loads(line)
            except (ValueError, UnicodeDecodeError, RecursionError):
                continue
            if isinstance(record, dict):
                yield record, offset
    if position:
        raise ValueError('No turn marker in the last 4 MiB of the native transcript.')


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



def inspect(adapter, session, metadata, running):
    result = {'state': 'idle', 'updatedAt': None, 'completionId': None, 'detail': None}
    found = latest_file(adapter, session)
    if found is None:
        return result, None
    path, _ = found
    with path.open('rb') as stream:
        info = os.fstat(stream.fileno())
        marker = adapter.activity_marker(reverse_records(stream, info.st_size))
        if marker is not None:
            event, offset = marker
            state, updated = event
            point = checkpoint(stream, info, offset)
            token = hashlib.sha256(json.dumps(point, sort_keys=True).encode()).hexdigest()
            if covered(metadata['baseline'], stream, info, offset):
                state = 'idle'
            elif state == 'working' and not running:
                state = 'idle'
            elif state == 'finished' and covered(metadata['checked'], stream, info, offset):
                state = 'idle'
            result.update(state=state, updatedAt=timestamp(updated), completionId=token if state == 'finished' else None)
            return result, point
        return result, None


def describe(activity, running):
    try:
        return inspect(activity.adapter, activity.session, activity.read(), running)[0]
    except (OSError, ValueError) as error:
        return {'state': 'idle', 'updatedAt': None, 'completionId': None,
                'detail': 'Activity unavailable: ' + str(error)}


def acknowledge(activity, token, running):
    with activity.lock():
        metadata = activity.read()
        result, point = inspect(activity.adapter, activity.session, metadata, running)
        if result['state'] == 'finished' and result['completionId'] == token:
            # Pin the displayed completion, never a later file EOF.
            metadata['checked'] = point
            activity.save(metadata)
