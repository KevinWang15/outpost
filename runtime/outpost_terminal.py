"""Control client for the installed terminal service; no PTY or terminal state."""

import errno
import json
import os
import socket
import struct
from pathlib import Path

PROTOCOL = 1
VERSION = '1.0.0'
MAX_COLS = 400
MAX_ROWS = 200
EXECUTABLE = Path.home() / '.outpost' / 'bin' / 'outpost-terminal'


def command():
    if not os.access(EXECUTABLE, os.X_OK):
        raise ValueError('Outpost Terminal is missing. Open Required Software to install it.')
    return str(EXECUTABLE)


def request(path, message):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(3)
        connection.connect(path)
        # The daemon reports its own PID; authenticate that identity through
        # the kernel before using it to inspect or terminate a process tree.
        pid, uid, _gid = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if uid != os.getuid():
            raise ValueError('Terminal service belongs to a different user')
        data = json.dumps(message).encode()
        connection.sendall(struct.pack('>cI', b'C', len(data)) + data)

        def read(size):
            data = bytearray()
            while len(data) < size:
                chunk = connection.recv(size - len(data))
                if not chunk:
                    raise ValueError('Terminal service closed its control connection')
                data.extend(chunk)
            return data

        kind, size = struct.unpack('>cI', read(5))
        if kind != b'C' or size > 65536:
            raise ValueError('Invalid terminal service response')
        result = json.loads(read(size))
        if result.get('type') == 'error':
            raise ValueError(result.get('message', 'Terminal service failed'))
        if 'pid' in result and result['pid'] != pid:
            raise ValueError('Terminal service identity mismatch')
        return result


def status(path):
    try:
        result = request(path, {'type': 'status'})
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ECONNREFUSED):
            return None
        raise
    if result.get('protocol') != PROTOCOL:
        raise ValueError('Incompatible terminal service. Stop the session and install the current dependency.')
    return result
