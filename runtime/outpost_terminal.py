"""Terminal-service control client and harness child-process setup."""

import errno
import json
import os
import socket
import struct
import sys
from pathlib import Path

from outpost_frames import HEADER, control, header

PROTOCOL = 3
VERSION = '1.2.0'
MAX_COLS = 400
MAX_ROWS = 200
EXECUTABLE = Path.home() / '.outpost' / 'bin' / 'outpost-terminal'


class TerminalUnavailable(ValueError):
    """A dependency or service configuration needs an explicit user action."""


def child_command(arguments):
    """Claim the inherited PTY in the child, then replace the bootstrap with the CLI.

    Bun connects stdio to the slave but does not establish a controlling terminal.
    Without a foreground process group, TIOCSWINSZ cannot deliver SIGWINCH.
    Python is already required on targets; the bootstrap leaves no extra process.
    """
    bootstrap = """import fcntl, os, signal, sys, termios
os.setsid()
fcntl.ioctl(0, termios.TIOCSCTTY, 0)
os.tcsetpgrp(0, os.getpgrp())
for name in ('SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGPIPE', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGWINCH'):
    signal.signal(getattr(signal, name), signal.SIG_DFL)
signal.pthread_sigmask(signal.SIG_SETMASK, [])
os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
"""
    return [sys.executable, '-I', '-S', '-c', bootstrap, *arguments]


def command():
    if not os.access(EXECUTABLE, os.X_OK):
        raise TerminalUnavailable('Outpost Terminal is missing. Open Required Software to install it.')
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
        connection.sendall(control(message))

        def read(size):
            data = bytearray()
            while len(data) < size:
                chunk = connection.recv(size - len(data))
                if not chunk:
                    raise ValueError('Terminal service closed its control connection')
                data.extend(chunk)
            return data

        kind, size = header(read(HEADER.size), limit=65536)
        if kind != b'C':
            raise ValueError('Invalid terminal service response')
        result = json.loads(read(size))
        if result.get('type') == 'error':
            raise ValueError(result.get('message', 'Terminal service failed'))
        if 'pid' in result and result['pid'] != pid:
            raise ValueError('Terminal service identity mismatch')
        return result


def status(path):
    # Inspection and termination do not consume the screen protocol. Keep them
    # available when a running service needs an explicit restart after upgrade.
    try:
        result = request(path, {'type': 'status'})
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ECONNREFUSED):
            return None
        raise
    return result
