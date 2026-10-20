"""Small, durable lifecycle observations. Hooks never store prompts or tool output."""

import fcntl
import json
import os
import re
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

STATES = ('working', 'waiting', 'idle', 'finished', 'error', 'unknown')
ID = re.compile(r'(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|session_[A-Za-z0-9_-]{1,120})')


def read_json(path, limit=32768):
    try:
        with path.open('rb') as stream:
            raw = stream.read(limit + 1)
        if len(raw) > limit:
            raise ValueError('Activity metadata exceeds its size limit.')
        try:
            return json.loads(raw)
        except RecursionError as error:
            raise ValueError('Activity metadata is nested too deeply.') from error
    except FileNotFoundError:
        return None


def write_json(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix='.activity-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(value, stream, separators=(',', ':'))
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


@contextmanager
def file_lock(path):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with path.open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def event_state(event, payload):
    if event in (
        'UserPromptSubmit',
        'PreToolUse',
        'PostToolUse',
        'PostToolUseFailure',
        'ElicitationResult',
    ):
        return 'working'
    if event in ('PermissionRequest', 'Elicitation'):
        return 'waiting'
    if event == 'Notification':
        return 'waiting' if payload.get('notification_type') in ('permission_prompt', 'elicitation_dialog') else None
    if event == 'StopFailure':
        return 'error'
    if event == 'Stop':
        return 'finished'
    if event in ('Interrupt', 'SessionEnd'):
        return 'idle'
    return None


def record(directory, session_id, generation, payload, received=None, identity_only=False):
    """Accept only events for this launch and the foreground conversation.

    SessionStart / human submission may select a new conversation. A late
    completion or exit from an old conversation cannot switch it back.
    """
    if not isinstance(payload, dict) or not ID.fullmatch(session_id):
        return
    native = payload.get('session_id')
    event = payload.get('hook_event_name')
    if not isinstance(native, str) or not ID.fullmatch(native):
        return
    if payload.get('agent_id') not in (None, 'main') or payload.get('isSidechain'):
        return
    received = time.time_ns() if received is None else received
    path = directory / (session_id + '.events.json')
    with file_lock(directory / (session_id + '.events.lock')):
        current = read_json(path)
        if not current or current.get('generation') != generation:
            return
        if received < current['received']:
            return
        binding = event in ('SessionStart', 'UserPromptSubmit')
        if native != current['session'] and not binding:
            return
        if event == 'SessionStart' and payload.get('source') == 'compact':
            # Compaction is not a selection or evidence of idleness. Foreground
            # forks are selections; native subagent hooks are filtered above.
            return
        state = None if identity_only else event_state(event, payload)
        if state is None and not binding:
            return  # Unrelated notifications cannot mint a new completion ID.
        if event == 'SessionEnd' and current.get('state') in ('finished', 'error'):
            return  # Exiting must not discard an unread completion or failure.
        changed = native != current['session']
        if changed or event == 'SessionStart':
            current.update(session=native, state=None if identity_only else 'idle', turn=None)
        elif event == 'UserPromptSubmit':
            current['turn'] = None
        turn = payload.get('turn_id')
        if isinstance(turn, (str, int)) and not isinstance(turn, bool):
            turn = str(turn)[:160]
            if state in ('finished', 'idle', 'error') and current.get('turn') not in (None, turn):
                return
            if state == 'finished' and current.get('state') == state and current.get('turn') == turn:
                return
            current['turn'] = turn
        if state is not None:
            current['state'] = state
        current.update(received=received, observed=True, event=event)
        # A binding-only hook must not erase a newer transcript-derived state.
        write_json(path, current)


def main():
    received = time.time_ns()
    # Kimi's local plugin is shared by the native store, but inert outside an
    # Outpost launch. Claude/Codex use explicit arguments, also across daemons.
    args = sys.argv[1:]
    if args == ['kimi']:
        if os.environ.get('OUTPOST_ACTIVITY_HARNESS') != 'kimi':
            return
        session_id = os.environ.get('OUTPOST_SESSION_ID', '')
        generation = os.environ.get('OUTPOST_ACTIVITY_GENERATION', '')
        directory = Path(os.environ.get('OUTPOST_ACTIVITY_DIRECTORY', ''))
        if not directory.is_absolute():
            return
    elif len(args) == 3:
        directory, session_id, generation = Path(args[0]), args[1], args[2]
    else:
        return
    if not session_id or not generation:
        return
    # Native hooks can include images and tool output. Bound ingestion; nothing
    # from their contents is written to disk or returned to the coding agent.
    raw = sys.stdin.buffer.read(16 * 1024 * 1024 + 1)
    if len(raw) > 16 * 1024 * 1024:
        return
    record(directory, session_id, generation, json.loads(raw), received, identity_only=args == ['kimi'])


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # An optional observer must never block/deny an agent action or emit
        # instructions to the model. Observation failures surface in Outpost.
        pass
