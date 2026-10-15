"""Shared live activity and bounded unread-completion detection."""

import datetime
import hashlib
import json
import os

from outpost_activity_state import checkpoint, covered, latest_file

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
            buffer = buffer[: newline + 1]
            end = position + len(buffer)
            trim_partial = False
        while buffer:
            separator = buffer[:-1].rfind(b'\n')
            if separator < 0 and position:
                break
            line = buffer[separator + 1 :]
            offset = end
            end -= len(line)
            buffer = buffer[: separator + 1]
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


def inspect(activity, running, live, metadata=None):
    adapter, session = activity.adapter, activity.session
    result = {'state': 'idle', 'updatedAt': None, 'completionId': None, 'detail': None}
    if live is not None and live.state != 'idle':
        result.update(state=live.state, detail=live.detail)
        return result, None
    # Liveness wins even when acknowledgement metadata is missing/corrupt.
    # Only completed-turn notices consult the persisted checkpoints for a
    # harness with authoritative live state.
    if metadata is None:
        metadata = activity.read()
    if live is None:
        found = latest_file(adapter, session)
        path = found[0] if found else None
    else:
        path = live.path
    if path is None:
        return result, None
    with path.open('rb') as stream:
        info = os.fstat(stream.fileno())
        marker = adapter.activity_marker(reverse_records(stream, info.st_size))
        if marker is not None:
            event, offset = marker
            state, updated = event
            if state == 'unknown':
                result = unavailable(
                    'The native transcript records an operation whose live status cannot be confirmed.'
                )
                result['updatedAt'] = timestamp(updated)
                return result, None
            point = checkpoint(stream, info, offset)
            token = hashlib.sha256(json.dumps(point, sort_keys=True).encode()).hexdigest()
            if live is not None and state != 'finished':
                state = live.state
            elif covered(metadata['baseline'], stream, info, offset):
                state = 'idle'
            elif state == 'working' and not running:
                state = 'idle'
            elif state == 'finished' and covered(metadata['checked'], stream, info, offset):
                state = 'idle'
            result.update(
                state=state, updatedAt=timestamp(updated), completionId=token if state == 'finished' else None
            )
            return result, point
        return result, None


def unavailable(detail):
    return {
        'state': 'unknown',
        'updatedAt': None,
        'completionId': None,
        'detail': 'Activity unavailable: ' + str(detail)[:4000],
    }


def describe(activity, running):
    try:
        live = activity.adapter.live_activity(activity.session, running)
        return inspect(activity, running, live)[0]
    except (OSError, ValueError) as error:
        return unavailable(error)


def acknowledge(activity, token, running):
    # Socket I/O must never hold the lock used by the terminal input path.
    # Even if a new turn starts after this observation, the exact completion
    # token below can acknowledge only the old notice, never that new turn.
    live = activity.adapter.live_activity(activity.session, running)
    if live is not None and live.state != 'idle':
        return
    with activity.lock():
        metadata = activity.read()
        result, point = inspect(activity, running, live, metadata)
        if result['state'] == 'finished' and result['completionId'] == token:
            # Pin the displayed completion, never a later file EOF.
            metadata['checked'] = point
            activity.save(metadata)
