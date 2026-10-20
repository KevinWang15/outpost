"""Codex's live thread status and authoritative, read-only rollout selection.

The existing daemon owns liveness. SQLite's selected path is used for local
completion checkpoints without making a socket request on terminal input.
Neither path starts/resumes a thread, subscribes to it, or invokes a model.
"""

import errno
import sqlite3
import time
from contextlib import closing
from pathlib import Path

from outpost_harness import LiveActivity, LiveStatusUnavailable
from outpost_rpc_socket import JsonRpcSocket


def rollout_path(home, value):
    if value is None:
        return None  # A new thread can be live before its rollout is materialized.
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise ValueError('Codex returned an invalid transcript path')
    path = Path(value)
    if not path.is_absolute() or path.is_symlink() or not path.resolve().is_relative_to(home):
        raise ValueError('Codex transcript is outside its pinned storage directory')
    if path.exists() and not path.is_file():
        raise ValueError('Codex transcript is not a regular file')
    return path


def selected_rollout(home, thread_id):
    """Never guess by filename/mtime: reverts retain obsolete rollout segments."""
    database = home / 'state_5.sqlite'
    if not database.exists():
        return None  # Outpost can allocate a new thread before Codex creates its index.
    if database.is_symlink():
        raise ValueError('Codex thread index must be inside its pinned storage directory')
    deadline = time.monotonic() + 0.25
    try:
        with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=0.1)) as connection:
            connection.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
            row = connection.execute('SELECT rollout_path FROM threads WHERE id = ?', (thread_id,)).fetchone()
    except sqlite3.Error as error:
        raise ValueError('Could not read the Codex thread index: ' + str(error)) from error
    return rollout_path(home, row[0]) if row else None


def read_thread(home, thread_id):
    # A separate `codex app-server` process cannot report this daemon's live state.
    with JsonRpcSocket(home / 'app-server-control' / 'app-server-control.sock') as connection:
        connection.call('initialize', {'clientInfo': {'name': 'outpost_activity', 'version': '1.0.0'}})
        connection.send({'jsonrpc': '2.0', 'method': 'initialized', 'params': {}})
        result = connection.call('thread/read', {'threadId': thread_id, 'includeTurns': False})
    thread = result.get('thread')
    if not isinstance(thread, dict) or thread.get('id') != thread_id or not isinstance(thread.get('status'), dict):
        raise ValueError('Codex returned invalid thread status')
    return thread


def observe(home, thread_id, running):
    try:
        thread = read_thread(home, thread_id)
    except OSError as error:
        if not running and error.errno in (errno.ENOENT, errno.ECONNREFUSED):
            # With no daemon and no terminal, only unread persisted completions
            # remain meaningful. A missing daemon for a running CLI is Unknown.
            return LiveActivity('idle', selected_rollout(home, thread_id))
        if error.errno in (errno.ENOENT, errno.ECONNREFUSED):
            raise LiveStatusUnavailable(
                'The shared Codex daemon is unavailable; lifecycle tracking requires a session restart.'
            ) from error
        raise ValueError('Could not read live Codex status: ' + str(error)) from error
    status = thread['status']
    kind = status.get('type')
    if kind == 'active':
        flags = status.get('activeFlags')
        if not isinstance(flags, list) or any(
            flag not in ('waitingOnApproval', 'waitingOnUserInput') for flag in flags
        ):
            raise ValueError('Codex returned invalid active status')
        waiting = []
        if 'waitingOnApproval' in flags:
            waiting.append('approval')
        if 'waitingOnUserInput' in flags:
            waiting.append('your input')
        detail = 'Codex has an active turn waiting for ' + ' and '.join(waiting) + '.' if waiting else None
        # Live work survives terminal restarts and never depends on a saved
        # task_started, startup baseline, or completion acknowledgement.
        return LiveActivity('waiting' if waiting else 'working', detail=detail)
    if kind == 'systemError':
        return LiveActivity('error', detail='Codex reports a thread error.')
    if kind == 'notLoaded' and running:
        raise LiveStatusUnavailable(
            'This conversation is not loaded in the shared Codex daemon. '
            'Restart this managed session to enable tracking of conversation switches.'
        )
    if kind not in ('idle', 'notLoaded'):
        raise ValueError('Codex returned an unsupported thread status')
    return LiveActivity('idle', rollout_path(home, thread.get('path')))
