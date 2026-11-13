"""Shared activity helper packaging; native hook configuration belongs to adapters."""

import shlex
import sys

import outpost_activity_events as events
from outpost_storage import replace_file


def install_helper(directory):
    path = directory / 'outpost-activity-hook.py'
    source = events.__loader__.get_source(events.__name__)
    if source is None:
        raise ValueError('Activity hook source is unavailable')
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        if path.read_bytes() == source.encode():
            return path
    except FileNotFoundError:
        pass
    replace_file(path, source)
    return path


def hook_command(directory, session, generation):
    helper = install_helper(directory.parent / 'bin')
    return shlex.join([sys.executable, '-I', str(helper), str(directory), session['id'], generation])
