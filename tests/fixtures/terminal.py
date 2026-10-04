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
        elif b'Press Enter to reconnect' in output:
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
    def wait_for_banner(timeout=5):
        global output
        deadline = time.time() + timeout
        while b'Press Enter to reconnect' not in output and time.time() < deadline:
            if select.select([fd], [], [], 0.2)[0]:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output += chunk
        if b'DISCONNECTED' not in output or b'Press Enter to reconnect' not in output:
            raise RuntimeError('No reconnect banner: ' + output.decode(errors='replace'))

    if sys.argv[2] in ('reconnect', 'network-reconnect'):
        first_pid = re.search(rb'OUTPOST_FIXTURE_READY (\d+)', output).group(1)
        for attempt in range(2 if sys.argv[2] == 'reconnect' else 1):
            output = b''
            if sys.argv[2] == 'reconnect':
                os.write(fd, b'\x1c')
            wait_for_banner(15)
            os.write(fd, b'x')
            time.sleep(0.25)
            if select.select([fd], [], [], 0)[0]:
                output += os.read(fd, 65536)
            if b'Connecting.' in output:
                raise RuntimeError('Reconnected without Enter')
            output = b''
            os.write(fd, b'\r')
            deadline = time.time() + 10
            while not painted() and time.time() < deadline:
                if select.select([fd], [], [], 0.2)[0]:
                    output += os.read(fd, 65536)
            if not painted() or re.search(rb'OUTPOST_FIXTURE_READY (\d+)', output).group(1) != first_pid:
                raise RuntimeError('Reconnect did not preserve the coding process: ' + output.decode(errors='replace'))
    if real_codex or sys.argv[2] in ('detach', 'clipboard', 'keyboard', 'reconnect', 'network-reconnect'):
        output_before_detach = output
        output = b''
        os.write(fd, b'\x1c')
        wait_for_banner()
        os.write(fd, b'\x03')
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
            raise RuntimeError('Ctrl+C did not exit the disconnected terminal: ' + output.decode(errors='replace'))
        output = output_before_detach + output
    elif sys.argv[2] == 'exit':
        os.write(fd, b'exit\n')
        time.sleep(0.3)
    elif sys.argv[2] == 'hold':
        time.sleep(1)
    elif sys.argv[2] == 'until-disconnected':
        wait_for_banner(15)
        os.write(fd, b'\x03')
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
