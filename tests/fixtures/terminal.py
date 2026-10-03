"""Exercise downloaded Bash/PowerShell commands inside a controlling terminal."""
import base64
import json
import fcntl
import os
import pty
import re
import select
import signal
import sys
import struct
import termios
import time

pid, fd = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
    if sys.argv[1].endswith('.ps1'):
        os.execvp(os.environ['OUTPOST_PWSH'], [os.environ['OUTPOST_PWSH'], '-NoLogo', '-NoProfile', '-File', sys.argv[1]])
    os.execvp('bash', ['bash', sys.argv[1]])
output = b''
real_codex = sys.argv[2] == 'real-codex'
queries_seen = {}
painted_at = None


def painted():
    plain = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', output)
    if real_codex:
        return re.search(rb'Welcome to Codex|Sign in with ChatGPT|Sign in with an API key', plain)
    return re.search(rb'OUTPOST_FIXTURE_READY \d+ 100x30', plain)


try:
    deadline = time.time() + 20
    while time.time() < deadline:
        if select.select([fd], [], [], 0.2)[0]:
            try:
                output += os.read(fd, 65536)
            except OSError:
                break
            if real_codex:
                # Minimal terminal replies for Codex's startup and cursor probes.
                for query, reply in [(b'\x1b[6n', b'\x1b[1;1R'), (b'\x1b[?u', b'\x1b[?0u'),
                                     (b'\x1b[c', b'\x1b[?1;2c'), (b'\x1b[>c', b'\x1b[>0;1;0c'),
                                     (b'\x1b]10;?\x1b\\', b'\x1b]10;rgb:ffff/ffff/ffff\x1b\\'),
                                     (b'\x1b]11;?\x1b\\', b'\x1b]11;rgb:0000/0000/0000\x1b\\')]:
                    count = output.count(query)
                    if count > queries_seen.get(query, 0):
                        os.write(fd, reply * (count - queries_seen.get(query, 0)))
                        queries_seen[query] = count
        if painted():
            if painted_at is None:
                painted_at = time.monotonic()
            if not real_codex or time.monotonic() - painted_at >= 0.6:
                break
    if not painted():
        raise RuntimeError('No interactive process: ' + output.decode(errors='replace'))
    if len(sys.argv) > 3:
        with open(sys.argv[3], 'w') as stream:
            stream.write('ready')
    if sys.argv[2] == 'clipboard':
        os.write(fd, b'clip')
        time.sleep(0.05)
        os.write(fd, b'board\n')
        deadline = time.time() + 5
        while b'T1VUUE9TVF9DTElQQk9BUkRfVEVTVA==' not in output and time.time() < deadline:
            if select.select([fd], [], [], 0.2)[0]:
                output += os.read(fd, 65536)
        if b'\x1b]52;' not in output or b'T1VUUE9TVF9DTElQQk9BUkRfVEVTVA==' not in output:
            raise RuntimeError('Clipboard escape did not reach the terminal: ' + output.decode(errors='replace'))
    if sys.argv[2] == 'keyboard':
        # Wait past the fixture's late startup reset and the second negotiation
        # attempt, then send both extended-key formats plus ordinary controls.
        time.sleep(3.5)
        # tmux can repaint an earlier completion on reconnect. Wait for this
        # input's acknowledgment before detaching, rather than retained output.
        completion = ('OUTPOST_KEYBOARD_COMPLETE:' + os.environ.get('OUTPOST_KEYBOARD_PROBE', '1') + '!').encode()
        os.write(fd, b'A\x1b[13;2uB\x1b[27;2;13~C\r\x03\x1a\x0cOUTPOST_KEYS_END')
        deadline = time.time() + 5
        while completion not in output and time.time() < deadline:
            if select.select([fd], [], [], 0.2)[0]:
                output += os.read(fd, 65536)
        if completion not in output:
            raise RuntimeError('Keyboard probe did not reach the session: ' + output.decode(errors='replace'))
    if real_codex or sys.argv[2] in ('detach', 'clipboard', 'keyboard'):
        os.write(fd, b'\x1c')
        deadline = time.time() + 5
        while time.time() < deadline:
            if select.select([fd], [], [], 0.2)[0]:
                try:
                    chunk = os.read(fd, 65536)
                    if not chunk:
                        break
                    output += chunk
                except OSError:
                    break
        else:
            raise RuntimeError('Detach shortcut did not close the connection')
    elif sys.argv[2] == 'exit':
        os.write(fd, b'exit\n')
        time.sleep(0.3)
    elif sys.argv[2] == 'hold':
        time.sleep(1)
    elif sys.argv[2] == 'until-disconnected':
        deadline = time.time() + 15
        while time.time() < deadline:
            if select.select([fd], [], [], 0.2)[0]:
                try:
                    chunk = os.read(fd, 65536)
                    if not chunk:
                        break
                    output += chunk
                except OSError:
                    break
        else:
            raise RuntimeError('Attached terminal did not disconnect after termination')
    elif sys.argv[2] == 'interactive':
        print(json.dumps({'ready': True, 'focusReporting': b'\x1b[?1004h' in output}), flush=True)
        while True:
            readers = select.select([0, fd], [], [], 0.2)[0]
            if 0 in readers:
                line = sys.stdin.readline()
                if not line:
                    break
                os.write(fd, base64.b64decode(json.loads(line)['input']))
                print(json.dumps({'sent': True}), flush=True)
            if fd in readers:
                try:
                    chunk = os.read(fd, 65536)
                    if not chunk:
                        break
                    output += chunk
                except OSError:
                    break
    print(json.dumps({'output': output.decode(errors='replace')}))
finally:
    os.close(fd)
    try:
        os.kill(pid, signal.SIGHUP)
    except ProcessLookupError:
        pass
    os.waitpid(pid, 0)
