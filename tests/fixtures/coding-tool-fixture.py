#!/usr/bin/env python3
"""A visible interactive test process, standing in for the selected coding tool."""
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time
import tty
import uuid

if Path('capture-input').exists():
    tty.setraw(sys.stdin.fileno())
    print('\x1b[?2004h', end='', flush=True)

tool = Path(sys.argv[0]).name

if '--version' in sys.argv:
    print(tool + ' test fixture')
    sys.exit(0)

if '--help' in sys.argv:
    print('Commands: acp session')
    sys.exit(0)

if tool == 'codex' and sys.argv[1:] == ['app-server']:
    for line in sys.stdin:
        request = json.loads(line)
        if 'id' not in request:
            continue
        if request['method'] == 'initialize':
            result = {'userAgent': 'codex-cli 0.159.2-fixture'}
        elif request['method'] == 'thread/start':
            result = {'thread': {'id': str(uuid.uuid4()), 'cliVersion': '0.159.2-fixture'}, 'modelProvider': 'fixture'}
        else:
            print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'error': {'code': -32601, 'message': 'Unsupported method'}}), flush=True)
            continue
        print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)
    sys.exit(0)

if tool == 'kimi' and sys.argv[1:] == ['acp']:
    for line in sys.stdin:
        request = json.loads(line)
        if request['method'] == 'initialize':
            result = {'protocolVersion': 1, 'agentCapabilities': {}}
        elif request['method'] == 'session/new':
            session_id = 'session_' + uuid.uuid4().hex
            home = Path(os.environ['KIMI_CODE_HOME'])
            directory = home / 'sessions' / 'fixture' / session_id
            directory.mkdir(parents=True)
            (directory / 'agents' / 'main').mkdir(parents=True)
            (directory / 'agents' / 'main' / 'wire.jsonl').touch()
            state = {'id': session_id, 'cwd': request['params']['cwd'], 'createdAt': time.time() * 1000, 'updatedAt': time.time() * 1000}
            (directory / 'state.json').write_text(json.dumps(state))
            with (home / 'session_index.jsonl').open('a') as stream:
                stream.write(json.dumps({'sessionId': session_id, 'sessionDir': str(directory), 'workDir': state['cwd']}) + '\n')
            result = {'sessionId': session_id}
        else:
            print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'error': {'code': -32601, 'message': 'Unsupported method'}}), flush=True)
            continue
        print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)
    sys.exit(0)

native_arguments = sys.argv[1:]
if tool == 'codex' and len(native_arguments) >= 2 and native_arguments[0] == 'resume':
    cli_session_id = native_arguments[1]
    history = next((Path(os.environ['CODEX_HOME']) / 'sessions').glob('**/*' + cli_session_id + '.jsonl'))
    assert json.loads(history.read_text().splitlines()[0])['payload']['id'] == cli_session_id
    arguments = native_arguments[2:]
elif tool == 'claude' and len(native_arguments) >= 2 and native_arguments[0] in ('--session-id', '--resume'):
    reference = native_arguments[1]
    cli_session_id = Path(reference).stem if native_arguments[0] == '--resume' else reference
    arguments = native_arguments[2:]
    history = Path(reference) if native_arguments[0] == '--resume' else Path(os.environ['CLAUDE_CONFIG_DIR']) / 'projects' / 'fixture' / (cli_session_id + '.jsonl')
    history.parent.mkdir(parents=True, exist_ok=True)
    if not history.exists():
        history.write_text(json.dumps({'type': 'user', 'sessionId': cli_session_id, 'cwd': str(Path.cwd()), 'message': {'role': 'user', 'content': 'Fixture conversation'}}) + '\n')
elif tool == 'kimi' and len(native_arguments) >= 2 and native_arguments[0] == '--session':
    cli_session_id = native_arguments[1]
    assert any((Path(os.environ['KIMI_CODE_HOME']) / 'sessions').glob('*/' + cli_session_id + '/state.json'))
    arguments = native_arguments[2:]
else:
    raise ValueError('Expected an exact coding CLI session ID')

pid = os.getpid()
with open('starts.log', 'a') as stream:
    stream.write(str(pid) + '\n')

# Exercise child-process cleanup, including a child that ignores TERM and HUP.
if Path('spawn-child').exists():
    Path('child.pid').unlink(missing_ok=True)
    subprocess.Popen([sys.executable, '-c', '''
import os, signal, time
from pathlib import Path
signal.signal(signal.SIGTERM, signal.SIG_IGN)
signal.signal(signal.SIGHUP, signal.SIG_IGN)
Path('child.pid').write_text(str(os.getpid()))
while True: time.sleep(1)
'''], start_new_session=True, stdin=subprocess.DEVNULL,
       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    while not Path('child.pid').exists():
        time.sleep(0.01)

last_size = None
keyboard_reset_at = time.monotonic() + 1.7 if Path('keyboard-reset').exists() else None
if keyboard_reset_at is not None:
    print('\x1b[>5u\x1b[>4;0m', end='', flush=True)


def ready(*_):
    global last_size
    size = os.get_terminal_size()
    # Model a TUI that only repaints when geometry changes, not on a redundant
    # SIGWINCH. Reattaching with the same dimensions used to leave it blank.
    if size == last_size:
        return
    last_size = size
    with open('sizes.log', 'a') as stream:
        stream.write(str(size.columns) + 'x' + str(size.lines) + '\n')
    print('OUTPOST_FIXTURE_READY ' + str(pid) + ' ' + str(size.columns) + 'x' + str(size.lines), flush=True)

signal.signal(signal.SIGWINCH, ready)
heartbeat = Path('heartbeat.json')
temporary_heartbeat = Path('.heartbeat-' + str(pid) + '.tmp')
input_tail = b''
keyboard_probes = 0
while True:
    if keyboard_reset_at is not None and time.monotonic() >= keyboard_reset_at:
        print('\x1b[>4;0m', end='', flush=True)
        Path('keyboard-reset-done').write_text('done')
        keyboard_reset_at = None
    temporary_heartbeat.write_text(json.dumps({'pid': pid, 'tool': tool, 'time': time.time(), 'cwd': os.getcwd(),
                                              'args': arguments, 'nativeArgs': native_arguments, 'cliSessionId': cli_session_id,
                                              'env': {key: value for key, value in os.environ.items() if key.startswith('OUTPOST_SESSION_')}}))
    temporary_heartbeat.replace(heartbeat)
    ready()
    if select.select([sys.stdin], [], [], 0.1)[0]:
        command = os.read(sys.stdin.fileno(), 1024)
        if Path('capture-input').exists():
            with open('input.bin', 'ab') as stream:
                stream.write(command)
        incoming = input_tail + command

        def received(marker):
            # Match newly completed controls, including ones split across reads.
            return marker in incoming[max(0, len(input_tail) - len(marker) + 1):]

        if received(b'clipboard'):
            print('\x1b]52;c;T1VUUE9TVF9DTElQQk9BUkRfVEVTVA==\x07', end='', flush=True)
        if received(b'OUTPOST_KEYS_END'):
            keyboard_probes += 1
            print('OUTPOST_KEYBOARD_COMPLETE:' + str(keyboard_probes) + '!', flush=True)
        if received(b'exit'):
            break
        if received(b'ping'):
            ready()
        input_tail = incoming[-(len(b'OUTPOST_KEYS_END') - 1):]
