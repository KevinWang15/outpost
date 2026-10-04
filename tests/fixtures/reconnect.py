"""Drive an interactive reconnect prompt after native processes exit or crash."""
import json
import os
import pty
import select
import signal
import sys
import termios
import time

pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
original_settings = termios.tcgetattr(fd)
output = b''
exited = False


def read_output(timeout=0.2):
    global output
    if select.select([fd], [], [], timeout)[0]:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            chunk = b''
        output += chunk
        return bool(chunk)
    return True


def wait_for(marker):
    deadline = time.monotonic() + 8
    while marker not in output and time.monotonic() < deadline:
        if not read_output():
            break
    if marker not in output:
        raise RuntimeError('Missing ' + repr(marker) + ': ' + output.decode(errors='replace'))


try:
    for attempt in range(1, 4):
        wait_for(('OUTPOST_ATTEMPT:' + str(attempt)).encode())
        wait_for(b'Ctrl+C to exit')
        if b'DISCONNECTED' not in output:
            raise RuntimeError('No disconnected banner')
        if attempt == 2 and b'exited with code 23' not in output:
            raise RuntimeError('Connection failure was not reported')
        if os.waitpid(pid, os.WNOHANG)[0]:
            exited = True
            raise RuntimeError('Wrapper exited instead of waiting for Enter')
        os.write(fd, b'x')
        deadline = time.monotonic() + 0.3
        while time.monotonic() < deadline:
            read_output(0.05)
        if ('OUTPOST_ATTEMPT:' + str(attempt + 1)).encode() in output:
            raise RuntimeError('Retried before Enter')
        output = b''
        if attempt < 3:
            os.write(fd, b'\r')
    os.write(fd, b'\x03')
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        ended, status = os.waitpid(pid, os.WNOHANG)
        if ended:
            exited = True
            if not os.WIFEXITED(status) or os.WEXITSTATUS(status) not in (0, 130):
                raise RuntimeError('Wrapper did not exit cleanly: ' + str(status))
            break
        read_output()
    if not exited:
        raise RuntimeError('Ctrl+C did not exit: ' + output.decode(errors='replace'))
    restored_settings = termios.tcgetattr(fd)
    if restored_settings != original_settings:
        raise RuntimeError('Original terminal settings were not restored')
    print(json.dumps({'attempts': 3, 'restored': True}))
finally:
    os.close(fd)
    if not exited:
        try:
            os.kill(pid, signal.SIGHUP)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
