"""Install one atomic Python zipapp; inject Codex MCP configuration per launch."""

import io
import os
import sys
import tempfile
import zipfile

import outpost_files
import outpost_mcp
from outpost_config import toml


def install(directory):
    archive = io.BytesIO(b'#!/usr/bin/env python3\n')
    archive.seek(0, 2)
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
        for name, module in [('__main__.py', outpost_mcp), ('outpost_files.py', outpost_files)]:
            source = module.__loader__.get_source(module.__name__)
            if source is None:
                raise ValueError('Outpost MCP source is unavailable')
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            bundle.writestr(info, source)
    data = archive.getvalue()
    path = directory / 'outpost-mcp'
    if path.exists() and path.read_bytes() == data:
        return path
    descriptor, temporary = tempfile.mkstemp(prefix='.outpost-mcp-', dir=directory)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)
            os.fchmod(stream.fileno(), 0o700)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return path


def arguments(tool, executable):
    if tool == 'codex':
        return [
            '-c',
            'mcp_servers.outpost='
            + toml(
                {
                    'command': sys.executable,
                    'args': ['-I', str(executable)],
                    'env_vars': ['OUTPOST_SESSION_ID', 'OUTPOST_STATE_DIRECTORY'],
                }
            ),
        ]
    return []
