"""Native activity, unread completion and observation health are independent."""

import datetime
import hashlib
import json
import os
import time

from outpost_activity_events import STATES, event_token, file_lock, read_json, write_json
from outpost_activity_state import covered, latest_file
from outpost_activity_transcript import marker, timestamp
from outpost_harness import LiveStatusUnavailable

STALE_SECONDS = 15


def result(state='idle', updated=None, completion=None, detail=None):
    return {
        'state': state,
        'updatedAt': updated,
        'completionId': completion,
        'detail': detail,
        'observation': 'current',
        'observedAt': None,
    }


def hook_observation(activity, events, running):
    if not events or not events.get('observed') or events.get('state') is None:
        return None
    state = events['state']
    if state in ('working', 'waiting') and not running:
        state = 'idle'
    token = event_token(events) if state == 'finished' else None
    if token and activity.event_seen(token):
        state, token = 'idle', None
    return result(state, timestamp(events['received'] / 1_000_000), token)


def transcript(activity, session, path=None):
    if path is None:
        found = latest_file(activity.adapter, session)
        path = found[0] if found else None
    selected = marker(activity.directory, session['id'], activity.adapter, path) if path else None
    return path, selected


def inspect(activity, running, events, reconcile=True):
    adapter = activity.adapter
    session = {**activity.session, 'cliSessionId': events['session']} if events else activity.session
    hook = hook_observation(activity, events, running)
    if hook is not None:
        # The current launch's native hooks own live state. No daemon request is
        # allowed to replace them: the shared daemon may not own this process.
        if reconcile and running and events['state'] in ('working', 'waiting'):
            try:
                path, selected = transcript(activity, session)
                native = selected[0] if selected else None
                updated = timestamp(native.timestamp) if native else None
                if (
                    native is not None
                    and native.state in ('idle', 'finished', 'error')
                    and updated is not None
                    and updated > hook['updatedAt']
                    and (events.get('turn') is None or native.turn == events['turn'])
                ):
                    # Recover a missed completion/interruption only from an
                    # explicit, newer native terminal event. Output, silence,
                    # daemon Idle and incomplete transcript entries aren't proof.
                    activity.recover(events, native.state, updated, path, selected[1])
                    # observe() rereads the lifecycle snapshot before publishing.
            except (OSError, ValueError):
                # Recovery is optional; failure doesn't invalidate a live hook.
                pass
        return hook, ('hook', hook['completionId']) if hook['completionId'] else None

    # Without lifecycle state (including Kimi's identity-only hooks), native
    # status/transcript evidence remains the primary observation source.
    live_error = None
    try:
        live = adapter.live_activity(session, running)
    except (OSError, ValueError) as error:
        live, live_error = None, error
    if live is not None and live.state != 'idle':
        return result(live.state, detail=live.detail), None
    path, selected = transcript(activity, session, live.path if live is not None else None)
    if selected is None:
        if events and events.get('error') and running:
            raise ValueError('Lifecycle integration could not start: ' + events['error'])
        if live_error is not None and (not isinstance(live_error, LiveStatusUnavailable) or events is None):
            raise live_error
        return result(), None
    return transcript_observation(activity, path, selected, running, events, live)


def transcript_observation(activity, path, selected, running, events, live=None):
    native, point = selected
    state, updated = native.state, timestamp(native.timestamp)
    offset = point['offset']
    if live is not None and state not in ('finished', 'error', 'unknown'):
        state = live.state
    if state in ('working', 'waiting') and not running:
        state = 'idle'
    if state == 'unknown':
        raise ValueError('The native transcript records an operation whose current state is unavailable.')
    with path.open('rb') as stream:
        info = os.fstat(stream.fileno())
        if not covered(point, stream, info, offset):
            raise ValueError('The native transcript changed while reading activity; retrying.')
        token = hashlib.sha256(json.dumps(point, sort_keys=True).encode()).hexdigest()
        if state == 'finished':
            if activity.transcript_seen(stream, info, offset):
                state = 'idle'
        elif state in ('working', 'waiting') and live is None and not (events and events.get('observed')):
            if covered(activity.read()['baseline'], stream, info, offset):
                state = 'idle'
    return result(state, updated, token if state == 'finished' else None), ('transcript', point)


def unavailable(detail):
    value = result('unknown', detail='Activity unavailable: ' + str(detail)[:4000])
    value['observation'] = 'unavailable'
    return value


def stale(previous, detail, now=None):
    now = time.time() if now is None else now
    if (
        isinstance(previous, dict)
        and previous.get('state') in STATES
        and isinstance(previous.get('observedAt'), str)
        and previous['state'] != 'unknown'
    ):
        try:
            observed = datetime.datetime.fromisoformat(previous['observedAt'].replace('Z', '+00:00')).timestamp()
        except (ValueError, TypeError):
            return unavailable(detail)
        if 0 <= now - observed <= STALE_SECONDS:
            return {**previous, 'observation': 'stale', 'detail': 'Activity update delayed: ' + str(detail)[:4000]}
    return unavailable(detail)


def identity(activity, events):
    return [events['generation'], events['session']] if events else [None, activity.session['cliSessionId']]


def observe(activity, running, reconcile=True):
    # A hook may select another conversation while a native API request is in
    # flight. Never publish (or acknowledge) the previous conversation's result.
    for _ in range(2):
        events = activity.events()
        value, point = inspect(activity, running, events, reconcile)
        latest = activity.events()
        if events == latest:
            return value, point, identity(activity, events)
    raise ValueError('The conversation changed while reading activity; retrying.')


def describe(activity, running, reconcile=True):
    # Bulk transcript/native API reads use a separate lock. Only the short
    # recovery/checkpoint commit synchronizes with acknowledgement and input.
    path = activity.directory / (activity.session['id'] + '.observation.json')
    try:
        with file_lock(activity.directory / (activity.session['id'] + '.observation.lock')):
            try:
                value, _, binding = observe(activity, running, reconcile)
                value['observedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
                write_json(path, {'identity': binding, 'value': value})
                return value
            except (OSError, ValueError) as error:
                try:
                    previous = read_json(path)
                except ValueError:
                    previous = None
                binding = identity(activity, activity.events())
                value = (
                    previous.get('value')
                    if isinstance(previous, dict) and previous.get('identity') == binding
                    else None
                )
                return stale(value, error)
    except (OSError, ValueError) as error:
        return unavailable(error)


def acknowledge(activity, token, running):
    value, point, _ = observe(activity, running)
    if value['state'] != 'finished' or value['completionId'] != token or point is None:
        return
    if point[0] == 'hook':
        # Store only this completion identity; a newer event is never cleared.
        activity.see_event(token)
    else:
        with activity.lock():
            metadata = activity.read()
            # Re-observation happened outside the input lock. Compare offsets
            # before saving so an older acknowledgement cannot undo a newer one.
            old = metadata['checked']
            if old and old['source'] == point[1]['source'] and old['offset'] > point[1]['offset']:
                return
            metadata['checked'] = point[1]
            activity.save(metadata)
