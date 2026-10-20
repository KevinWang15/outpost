"""Native activity, unread completion and observation health are independent."""

import datetime
import hashlib
import json
import os
import time

from outpost_activity_events import STATES, file_lock, read_json, write_json
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


def event_token(events):
    return hashlib.sha256(
        json.dumps([events['generation'], events['session'], events['received']]).encode()
    ).hexdigest()


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


def inspect(activity, running, events):
    adapter = activity.adapter
    session = {**activity.session, 'cliSessionId': events['session']} if events else activity.session
    hook = hook_observation(activity, events, running)
    try:
        live = adapter.live_activity(session, running)
    except LiveStatusUnavailable:
        # Embedded Codex instances have no shared-daemon status. Launch-scoped
        # hooks still identify the conversation and report native lifecycle.
        if hook is None and (events is None or events.get('error')):
            raise
        live = None
    if live is not None and live.state != 'idle':
        return result(live.state, detail=live.detail), None
    found = latest_file(adapter, session) if live is None else None
    path = found[0] if found else live.path if live is not None else None
    selected = marker(activity.directory, session['id'], adapter, path) if path else None
    updated = timestamp(selected[0][1]) if selected else None
    # A hook can arrive before its transcript flush. A subsequent transcript
    # event supersedes it. Kimi hooks select identity only, never subagent state.
    same_completion = (
        hook is not None and events['state'] == 'finished' and selected is not None and selected[0][0] == 'finished'
    )
    if hook is not None and (same_completion or updated is None or hook['updatedAt'] >= updated):
        if live is not None and hook['state'] in ('working', 'waiting'):
            # The daemon's idle observation supersedes a pre-submit hook or a
            # stale hook after an interrupted/failed turn.
            return result('idle', hook['updatedAt']), None
        return hook, ('hook', hook['completionId']) if hook['completionId'] else None
    if selected is None:
        if events and events.get('error') and running:
            raise ValueError('Lifecycle integration could not start: ' + events['error'])
        return result(), None
    (state, _), point = selected
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
            metadata = activity.read()
            if covered(metadata['baseline'], stream, info, offset) or covered(
                metadata['checked'], stream, info, offset
            ):
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


def observe(activity, running):
    # A hook may select another conversation while a native API request is in
    # flight. Never publish (or acknowledge) the previous conversation's result.
    for _ in range(2):
        events = activity.events()
        value, point = inspect(activity, running, events)
        latest = activity.events()
        if events == latest:
            return value, point, identity(activity, events)
    raise ValueError('The conversation changed while reading activity; retrying.')


def describe(activity, running):
    # Serialize observers separately from acknowledgement and input. A slow
    # filesystem or native status API never holds the terminal-input lock.
    path = activity.directory / (activity.session['id'] + '.observation.json')
    try:
        with file_lock(activity.directory / (activity.session['id'] + '.observation.lock')):
            try:
                value, _, binding = observe(activity, running)
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
