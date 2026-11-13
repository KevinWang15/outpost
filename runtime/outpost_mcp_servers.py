"""The MCP servers an Outpost launch provides, and the packaged Outpost server.

Every launch gets the same neutral descriptors from servers(), whichever driver
(terminal or chat) and harness runs it. Adapters only translate them into their
tool's native configuration; they never construct Outpost's server themselves.
"""

import io
import json
import sys
import zipfile

import outpost_files
import outpost_history_tools
import outpost_mcp
from outpost_storage import replace_file

DRIVERS = ('terminal', 'chat')


def install(directory):
    archive = io.BytesIO(b'#!/usr/bin/env python3\n')
    archive.seek(0, 2)
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
        for name, module in [
            ('__main__.py', outpost_mcp),
            ('outpost_files.py', outpost_files),
            ('outpost_history_tools.py', outpost_history_tools),
        ]:
            source = module.__loader__.get_source(module.__name__)
            if source is None:
                raise ValueError('Outpost MCP source is unavailable')
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            bundle.writestr(info, source)
        info = zipfile.ZipInfo('history-tools.json', date_time=(2026, 1, 1, 0, 0, 0))
        bundle.writestr(info, json.dumps(outpost_history_tools.definitions()))
    data = archive.getvalue()
    path = directory / 'outpost-mcp'
    if path.exists() and path.read_bytes() == data:
        return path
    replace_file(path, data, mode=0o700)
    return path


def context(state, session, driver):
    """The launch's binding, read by every Outpost MCP process and by `outpost-mcp
    publish`. The launcher sets it; tool arguments never select a session."""
    if driver not in DRIVERS:
        raise ValueError('Unknown Outpost session driver')
    return {'OUTPOST_SESSION_ID': session['id'], 'OUTPOST_STATE_DIRECTORY': str(state), 'OUTPOST_DRIVER': driver}


def servers(state, session, driver):
    """Stdio servers as {name, command, args, env}; env is the launch's binding."""
    return [
        {
            'name': 'outpost',
            'command': sys.executable,
            'args': ['-I', str(state / 'bin' / 'outpost-mcp')],
            'env': context(state, session, driver),
        }
    ]


def acp_servers(descriptors):
    """The same servers as ACP `mcpServers` (stdio)."""
    return [
        {
            'name': server['name'],
            'command': server['command'],
            'args': server['args'],
            'env': [{'name': key, 'value': value} for key, value in server['env'].items()],
        }
        for server in descriptors
    ]
