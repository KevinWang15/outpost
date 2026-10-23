"""Shared activity helper packaging; native hook configuration belongs to adapters."""

import os
import shlex
import sys
import tempfile

import outpost_activity_events as events


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
    descriptor, temporary = tempfile.mkstemp(prefix='.activity-hook-', dir=directory)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            stream.write(source)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return path


def hook_command(directory, session, generation):
    helper = install_helper(directory.parent / 'bin')
    return shlex.join([sys.executable, '-I', str(helper), str(directory), session['id'], generation])
