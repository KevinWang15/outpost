"""Run a command in a PTY, like a terminal app would.

Usage: pty_driver.py COLS ROWS -- COMMAND...
stdin takes JSON lines {"write": base64} or {"resize": [cols, rows]};
stdout emits JSON lines {"output": base64} and finally {"exit": code}.
"""

import base64
import fcntl
import json
import os
import pty
import select
import struct
import sys
import termios

cols, rows = int(sys.argv[1]), int(sys.argv[2])
command = sys.argv[sys.argv.index('--') + 1 :]
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    os.environ['TERM'] = 'xterm-256color'
    os.execvp(command[0], command)


def emit(message):
    sys.stdout.write(json.dumps(message) + '\n')
    sys.stdout.flush()


buffer = b''
while True:
    ready = select.select([0, fd], [], [])[0]
    if 0 in ready:
        chunk = os.read(0, 65536)
        if not chunk:
            os.close(fd)
            break
        buffer += chunk
        while b'\n' in buffer:
            line, buffer = buffer.split(b'\n', 1)
            message = json.loads(line)
            if 'write' in message:
                os.write(fd, base64.b64decode(message['write']))
            if 'resize' in message:
                fcntl.ioctl(
                    fd, termios.TIOCSWINSZ, struct.pack('HHHH', message['resize'][1], message['resize'][0], 0, 0)
                )
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b''
        if not data:
            break
        emit({'output': base64.b64encode(data).decode()})
_, status = os.waitpid(pid, 0)
emit({'exit': os.waitstatus_to_exitcode(status)})
