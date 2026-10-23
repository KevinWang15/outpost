"""Per-operation target management, sent locally or through SSH. Sessions belong to outpost-terminal."""

import base64
import datetime
import errno
import fcntl
import hashlib
import heapq
import json
import os
import pwd
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

import outpost_files
import outpost_mcp_install
import outpost_terminal as terminal
from outpost_activity_state import Activity
from outpost_harness import adapters

CODING_ADAPTERS = adapters()

os.umask(0o077)
STATE = Path.home() / '.outpost'
REGISTRY = STATE / 'registry.json'
HELPERS = STATE / 'bin'
FIELDS = {
    'id',
    'name',
    'rootDir',
    'createdAt',
    'lastConnectedAt',
    'tool',
    'env',
    'args',
    'cliSessionId',
    'cliSessionEnv',
}
IMAGE_EXTENSIONS = ('png', 'jpg', 'gif', 'webp')
MAX_IMAGE_BYTES = 16 * 1024 * 1024

# Installed as outpost-browser and outpost-signal. Talks to the newest relay of
# this session over a Unix socket; see SignalServer in outpost_relay.
HELPER = r'''#!/usr/bin/env python3
"""Outpost signal helper (outpost-browser URL | outpost-signal TYPE JSON)."""
import json
import os
import socket
import sys


def main():
    if os.path.basename(sys.argv[0]) == 'outpost-browser':
        if len(sys.argv) != 2:
            raise ValueError('Usage: outpost-browser URL')
        request = {'type': 'browser.open', 'payload': {'url': sys.argv[1]}}
    else:
        if len(sys.argv) != 3:
            raise ValueError('Usage: outpost-signal TYPE JSON_PAYLOAD')
        request = {'type': sys.argv[1], 'payload': json.loads(sys.argv[2])}
    session = os.environ.get('OUTPOST_SESSION_ID', '')
    if not session or '/' in session:
        raise ValueError('Run this inside an Outpost session.')
    body = json.dumps(request).encode() + b'\n'
    if len(body) > 32 * 1024:
        raise ValueError('Signals must fit within 32 KiB.')
    os.chdir(os.path.dirname(os.path.dirname(os.path.realpath(sys.argv[0]))))
    connection = socket.socket(socket.AF_UNIX)
    connection.settimeout(15)
    try:
        connection.connect('run/' + session + '.sock')
    except (FileNotFoundError, ConnectionRefusedError):
        raise ValueError('No Outpost terminal is connected to this session.')
    connection.sendall(body)
    response = b''
    while not response.endswith(b'\n'):
        chunk = connection.recv(4096)
        if not chunk:
            break
        response += chunk
    result = json.loads(response or b'{}')
    if not result.get('ok'):
        raise ValueError(result.get('message') or 'Outpost did not accept the signal.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError) as error:
        print('Outpost: ' + str(error), file=sys.stderr)
        sys.exit(1)
'''


def fail(message, status=400):
    print('OUTPOST_RESULT:' + json.dumps({'ok': False, 'error': {'message': message, 'status': status}}), flush=True)
    sys.exit(1)


def respond(data):
    print('OUTPOST_RESULT:' + json.dumps({'ok': True, 'data': data}), flush=True)


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def text(value, limit):
    return isinstance(value, str) and 0 < len(value) <= limit and all(ord(c) >= 32 and ord(c) != 127 for c in value)


def timestamp(value):
    return text(value, 80) and datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).tzinfo is not None


def save(data):
    descriptor, temporary = tempfile.mkstemp(prefix='.registry-', dir=STATE)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(data, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, REGISTRY)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def validate(data):
    if (
        not isinstance(data, dict)
        or not {'version', 'sessions'} <= set(data) <= {'version', 'sessions', 'creations'}
        or data['version'] != 2
        or not isinstance(data['sessions'], list)
    ):
        raise ValueError()
    # Only retryable creates allocate receipts. Retain receipts after deletion:
    # replaying an old request must never resurrect a deliberately removed session.
    creations = data.get('creations', {})
    if not isinstance(creations, dict):
        raise ValueError()
    for key, receipt in creations.items():
        if (
            not isinstance(key, str)
            or not re.fullmatch(r'[0-9a-f]{64}', key)
            or not isinstance(receipt, dict)
            or set(receipt) != {'fingerprint', 'sessionId'}
            or not isinstance(receipt['fingerprint'], str)
            or not re.fullmatch(r'[0-9a-f]{64}', receipt['fingerprint'])
            or not text(receipt['sessionId'], 36)
            or str(uuid.UUID(receipt['sessionId'])) != receipt['sessionId']
        ):
            raise ValueError()
    ids, names, conversations = set(), set(), set()
    for entry in data['sessions']:
        if not isinstance(entry, dict) or set(entry) != FIELDS:
            raise ValueError()
        if not text(entry['id'], 36) or str(uuid.UUID(entry['id'])) != entry['id'] or entry['id'] in ids:
            raise ValueError()
        adapter = CODING_ADAPTERS.get(entry['tool'])
        if (
            adapter is None
            or not adapter.valid_id(entry['cliSessionId'])
            or not adapter.valid_storage(entry['cliSessionEnv'])
        ):
            raise ValueError()
        if not valid_launch_options(entry['env'], entry['args']):
            raise ValueError()
        if not text(entry['name'], 80) or not entry['name'].strip() or entry['name'].casefold() in names:
            raise ValueError()
        if not text(entry['rootDir'], 4096) or not os.path.isabs(entry['rootDir']):
            raise ValueError()
        if not timestamp(entry['createdAt']) or (
            entry['lastConnectedAt'] is not None and not timestamp(entry['lastConnectedAt'])
        ):
            raise ValueError()
        conversation = (entry['tool'], entry['cliSessionId'], tuple(sorted(entry['cliSessionEnv'].items())))
        if conversation in conversations:
            raise ValueError()
        ids.add(entry['id'])
        names.add(entry['name'].casefold())
        conversations.add(conversation)
    return data


def read_registry():
    if not REGISTRY.exists():
        return {'version': 2, 'sessions': []}
    try:
        return validate(json.loads(REGISTRY.read_text()))
    except (ValueError, TypeError, KeyError):
        fail('Invalid session registry. Expected the current schema; no data was modified.', 409)


@contextmanager
def registry_lock():
    with open(STATE / 'registry.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def valid_launch_options(environment, arguments):
    if not isinstance(arguments, str) or len(arguments) > 8192 or '\0' in arguments:
        return False
    if not isinstance(environment, dict) or len(environment) > 32:
        return False
    if any(
        not isinstance(key, str)
        or len(key) > 128
        or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key)
        or not isinstance(value, str)
        or len(value) > 4096
        or '\0' in value
        for key, value in environment.items()
    ):
        return False
    return (
        len(
            json.dumps({'env': environment, 'args': arguments}, ensure_ascii=False, separators=(',', ':')).encode(
                'utf-8'
            )
        )
        <= 16 * 1024
    )


def install_helpers():
    HELPERS.mkdir(mode=0o700, exist_ok=True)
    outpost_mcp_install.install(HELPERS)
    for name in ('outpost-browser', 'outpost-signal'):
        path = HELPERS / name
        try:
            if path.read_text() == HELPER:
                continue
        except OSError:
            pass
        temporary = HELPERS / ('.' + name + '.' + uuid.uuid4().hex[:8])
        temporary.write_text(HELPER)
        temporary.chmod(0o700)
        os.replace(temporary, path)


def launch_script(session, executable, activity_generation=None, launch_arguments=()):
    # Environment values and paths are literal; only the argument string is shell text.
    steps = [
        'cd -- ' + shlex.quote(session['rootDir']),
        'export PATH=' + shlex.quote(str(HELPERS)) + ':"$PATH"',
        'export -- COLORTERM=truecolor BROWSER=' + shlex.quote(str(HELPERS / 'outpost-browser')),
    ]
    environment = {**session['env'], **session['cliSessionEnv']}
    if activity_generation is not None:
        environment.update(
            OUTPOST_ACTIVITY_GENERATION=activity_generation,
            OUTPOST_ACTIVITY_HARNESS=session['tool'],
            OUTPOST_ACTIVITY_DIRECTORY=str(STATE / 'activity'),
        )
    if environment:
        steps.append('export -- ' + ' '.join(key + '=' + shlex.quote(value) for key, value in environment.items()))
    # Session routing is launcher-owned even when the user supplies other environment settings.
    steps.append(
        'export OUTPOST_SESSION_ID='
        + shlex.quote(session['id'])
        + ' OUTPOST_STATE_DIRECTORY='
        + shlex.quote(str(STATE))
    )
    adapter = CODING_ADAPTERS[session['tool']]
    # Integration options precede the adapter's native conversation selector;
    # user arguments remain a separate, guarded suffix.
    flags = ' '.join(shlex.quote(value) for value in [*launch_arguments, *adapter.arguments(session)])
    # Bash expands the call's arguments once. The function checks that exact
    # argv and execs the CLI, preserving exec's behavior for shell operators.
    steps.append(
        'launch_coding_tool() {\n'
        + adapter.argument_guard()
        + '\n'
        + 'exec '
        + shlex.quote(executable)
        + ' '
        + flags
        + ' "$@"'
        + '\n}'
    )
    steps.append('launch_coding_tool ' + session['args'])
    return ' &&\n'.join(steps)


def socket_name(session):
    # Relative paths avoid the Unix socket path limit, even with long home directories.
    return 'terminals/' + session['id'] + '.sock'


def directory_suggestions(prefix):
    if not isinstance(prefix, str) or len(prefix) > 4096 or any(ord(c) < 32 or ord(c) == 127 for c in prefix):
        fail('Invalid directory path')
    if prefix in ('', '~'):
        prefix = '~/'
    if not prefix.startswith(('/', '~/')):
        fail('Directory path must be absolute or begin with ~/')
    parent, _, name = prefix.rpartition('/')
    parent += '/'

    def matches():
        # Inspect one directory only. Paths remain literal data, never shell code.
        with os.scandir(os.path.expanduser(parent)) as entries:
            for entry in entries:
                if not entry.name.startswith(name) or (entry.name.startswith('.') and not name.startswith('.')):
                    continue
                candidate = parent + entry.name + '/'
                if len(candidate) > 4096 or any(
                    ord(c) < 32 or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF for c in candidate
                ):
                    continue
                try:
                    if entry.is_dir():
                        yield candidate
                except OSError:
                    continue  # Entries may disappear or be unreadable during a lookup.

    try:
        directories = heapq.nsmallest(51, matches())
    except (FileNotFoundError, NotADirectoryError):
        directories = []
    except PermissionError:
        fail('Permission denied while reading the directory', 403)
    except OSError as error:
        fail('Could not read the directory: ' + str(error))
    return {'directories': directories[:50], 'truncated': len(directories) > 50}


def alive(session):
    return terminal.status(socket_name(session)) is not None


def describe(session):
    status = 'stopped' if session['lastConnectedAt'] else 'ready'
    service = terminal.status(socket_name(session))
    if service:
        status = 'attached' if service['clients'] else 'detached'
    return dict(session, status=status, activity=activity(session).describe(status in ('attached', 'detached')))


def activity(session):
    return Activity(STATE / 'activity', CODING_ADAPTERS[session['tool']], session)


def process_info(pid):
    try:
        fields = Path('/proc', str(pid), 'stat').read_text().rsplit(')', 1)[1].split()
        if fields[0] in ('Z', 'X'):
            return None
        return {'pid': pid, 'parent': int(fields[1]), 'start': fields[19]}
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return None


def same_process(process):
    current = process_info(process['pid'])
    return current is not None and current['start'] == process['start']


def save_image(session, extension, data):
    directory = STATE / 'clipboard' / session['id']
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / (
        datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S-%f-') + uuid.uuid4().hex + '.' + extension
    )
    pending = destination.with_suffix('.part')
    try:
        with pending.open('xb') as stream:
            pending.chmod(0o600)
            stream.write(data)
        pending.replace(destination)
    finally:
        pending.unlink(missing_ok=True)
    # Keep only the newest uploads per session.
    for stale in sorted(directory.iterdir())[:-20]:
        try:
            stale.unlink()
        except OSError:
            pass
    return destination


def upload_image(session, request):
    extension, size = request.get('extension'), request.get('size')
    if extension not in IMAGE_EXTENSIONS:
        fail('Unsupported image type. Use a PNG, JPEG, GIF, or WebP image.')
    if type(size) is not int or not 0 < size <= MAX_IMAGE_BYTES:
        fail('Images must be between 1 byte and 16 MB.', 413)
    # Read exactly one bounded raw body; never strip binary whitespace or
    # allocate a file for a truncated upload. Saving does not touch the PTY.
    data = sys.stdin.buffer.read(size + 1)
    if len(data) != size:
        fail('Incomplete or invalid image upload.')
    path = save_image(session, extension, data)
    reference = CODING_ADAPTERS[session['tool']].image_reference(str(path))
    return {'path': str(path), 'reference': reference}


def terminate_session(session):
    if not alive(session):
        Path(socket_name(session)).unlink(missing_ok=True)
        activity(session).initialize()
        return describe(session)
    # The Unix socket's SO_PEERCRED verifies the daemon PID and execution user.
    # Each daemon owns just this session's process tree.
    service = terminal.status(socket_name(session))
    if service is None:
        return describe(session)
    root = process_info(service['pid'])
    if not root:
        return describe(session)
    processes = {}
    for path in Path('/proc').iterdir():
        if path.name.isdigit():
            process = process_info(int(path.name))
            if process:
                processes[process['pid']] = process
    if not same_process(root):
        fail('The session exited while preparing to terminate it. Refresh and retry.', 409)
    targets = [root]
    included = {root['pid']}
    for parent in targets:
        for process in processes.values():
            if process['parent'] == parent['pid'] and process['pid'] not in included:
                included.add(process['pid'])
                targets.append(process)
    # Signal children before their parents. Pin process identities with pidfds
    # where supported; older kernels recheck /proc start times before signaling.
    targets.reverse()
    handles = {}
    try:
        if hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'):
            for process in targets:
                try:
                    handles[process['pid']] = os.pidfd_open(process['pid'])
                except ProcessLookupError:
                    continue
                except OSError as error:
                    if error.errno != errno.ENOSYS:
                        raise
                    break

        def send(process, sig):
            if not same_process(process):
                return
            try:
                handle = handles.get(process['pid'])
                if handle is not None:
                    signal.pidfd_send_signal(handle, sig)
                else:
                    os.kill(process['pid'], sig)
            except ProcessLookupError:
                pass

        for process in targets:
            send(process, signal.SIGTERM)
        deadline = time.monotonic() + 3
        while any(same_process(process) for process in targets) and time.monotonic() < deadline:
            time.sleep(0.05)
        for process in targets:
            send(process, signal.SIGKILL)
        deadline = time.monotonic() + 2
        while any(same_process(process) for process in targets) and time.monotonic() < deadline:
            time.sleep(0.05)
        if any(same_process(process) for process in targets) or alive(session):
            fail('Some session processes have not exited yet. Refresh and retry.', 409)
        Path(socket_name(session)).unlink(missing_ok=True)
        activity(session).initialize()
        return describe(session)
    finally:
        for handle in handles.values():
            os.close(handle)


def start_session(session, cols, rows):
    session = activity(session).selected_session()
    if not Path(session['rootDir']).is_dir():
        fail('Session root directory no longer exists', 409)
    tool = session['tool']
    executable = shutil.which(tool, path=session['env'].get('PATH', os.environ.get('PATH')))
    if not executable:
        fail(
            tool
            + ' is not on '
            + pwd.getpwuid(os.getuid()).pw_name
            + "'s interactive login PATH. Check that user's shell startup files before connecting.",
            409,
        )
    command_shell = shutil.which('bash')
    if not command_shell:
        fail('Bash is missing on this target. Open Required Software to install it.', 409)
    # Socket storage belongs to process startup, including an existing session
    # whose terminal has never run or whose socket directory was removed.
    (STATE / 'terminals').mkdir(mode=0o700, exist_ok=True)
    Path(socket_name(session)).unlink(missing_ok=True)
    install_helpers()
    integration_arguments = CODING_ADAPTERS[tool].prepare_launch(STATE, session)
    observer = activity(session)
    observer.initialize()
    activity_generation, activity_arguments = observer.begin_launch(executable)
    environment = dict(os.environ)
    environment.pop('TMUX', None)
    environment.pop('TMUX_PANE', None)
    environment.update(TERM='xterm-256color', COLORTERM='truecolor')
    configuration = {
        'socket': socket_name(session),
        'command': terminal.child_command(
            [
                command_shell,
                '-c',
                launch_script(session, executable, activity_generation, [*activity_arguments, *integration_arguments]),
            ]
        ),
        'cwd': session['rootDir'],
        'env': environment,
        'cols': cols,
        'rows': rows,
    }
    logs = STATE / 'logs'
    logs.mkdir(mode=0o700, exist_ok=True)
    log = logs / (session['id'] + '.log')
    with log.open('wb') as output:
        process = subprocess.Popen(
            [terminal.command(), 'serve'],
            stdin=subprocess.PIPE,
            stdout=output,
            stderr=output,
            cwd=STATE,
            start_new_session=True,
        )
        process.stdin.write(json.dumps(configuration).encode())
        process.stdin.close()
        for _ in range(100):
            if process.poll() is not None:
                fail('Terminal service could not start: ' + log.read_text(errors='replace')[-2000:], 409)
            if alive(session):
                return
            time.sleep(0.05)
        process.terminate()
        fail('Terminal service did not become ready. Open Required Software to reinstall it.', 409)


class AttachHooks:
    def __init__(self, session):
        self.session = session
        self.observer = activity(session)

    def on_input(self):
        self.observer.input()

    def activity(self):
        return self.observer.describe(alive(self.session))

    def acknowledge(self, completion_id):
        self.observer.acknowledge(completion_id, alive(self.session))


def attach_session(session, cols, rows):
    from outpost_relay import Relay

    service = terminal.status(socket_name(session))
    if service and service.get('protocol') != terminal.PROTOCOL:
        fail(
            'This session is running an incompatible terminal service. Install the current Outpost Terminal '
            'in Required Software, then Terminate and Connect this session to restart it.',
            409,
        )
    return Relay(socket_name(session), cols, rows, AttachHooks(session), 'run/' + session['id'] + '.sock').run()


def terminal_size(request):
    cols, rows = request.get('cols', 80), request.get('rows', 24)
    if (
        not isinstance(cols, int)
        or not isinstance(rows, int)
        or not 2 <= cols <= terminal.MAX_COLS
        or not 2 <= rows <= terminal.MAX_ROWS
    ):
        fail('Invalid terminal size')
    return cols, rows


def create_session(request):
    """Serialize allocation without holding up existing sessions.

    Lock order is creation -> registry. Only creators take creation.lock;
    deleting/attaching/listing sessions can proceed during Git or CLI work.
    The process-owned lock is released on failure, with no stale reservations.
    """
    action = request['action']
    creation_key = request.get('creationKey')
    if creation_key is not None and (
        action != 'create' or not isinstance(creation_key, str) or not re.fullmatch(r'[0-9a-f]{64}', creation_key)
    ):
        fail('Invalid creation request identity.')
    fingerprint = hashlib.sha256(
        json.dumps({k: v for k, v in request.items() if k != 'creationKey'}, sort_keys=True).encode()
    ).hexdigest()
    with open(STATE / 'creation.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with registry_lock():
            data = read_registry()
            sessions = data['sessions']
            receipt = data.get('creations', {}).get(creation_key)
            if receipt:
                if receipt['fingerprint'] != fingerprint:
                    fail('This creation request was already used with different session settings.', 409)
                session = next((s for s in sessions if s['id'] == receipt['sessionId']), None)
                if session is None:
                    fail('The session from this creation request has been deleted.', 410)
                return describe(session)
        if action == 'fork':
            source = next((s for s in sessions if s['id'] == request.get('id')), None)
            if source is None:
                fail('Session not found', 404)
            branch = request.get('branch')
            if not text(branch, 256) or branch != branch.strip():
                fail('Enter a valid new Git branch name.')
            name, suffix = branch[:80], 2
            while any(s['name'].casefold() == name.casefold() for s in sessions):
                ending = ' (' + str(suffix) + ')'
                name = branch[: 80 - len(ending)] + ending
                suffix += 1
            request = {
                'name': name,
                'rootDir': request['rootDir'],
                'tool': source['tool'],
                'env': source['env'],
                'args': source['args'],
            }
        tool = request['tool']
        environment, arguments = request['env'], request['args']
        if not valid_launch_options(environment, arguments):
            fail('Invalid environment variables or arguments')
        syntax = subprocess.run(['bash', '-n', '-c', 'exec "$1" ' + arguments], capture_output=True, text=True)
        if syntax.returncode:
            fail('Invalid Bash argument syntax: ' + syntax.stderr.strip())
        name = request['name'].strip()
        if any(s['name'].casefold() == name.casefold() for s in sessions):
            fail('A session with this name already exists on this target', 409)
        path = os.path.expanduser(request['rootDir'])
        if not text(path, 4096) or not os.path.isabs(path):
            fail('Root directory must be absolute or begin with ~/')
        root = Path(path).resolve()
        if request.get('createDirectory'):
            root.mkdir(parents=True, exist_ok=True)
        if action == 'create' and not root.is_dir():
            fail('Root directory does not exist. Enable Create directory or choose an existing directory.')
        launch_environment = dict(os.environ, **environment)
        if action == 'fork':
            launch_environment.update(source['cliSessionEnv'])
        executable = shutil.which(tool, path=launch_environment.get('PATH'))
        if not executable:
            fail(tool + ' is missing on this target. Check Required Software and your login PATH.', 409)
        # CLI identity is owned by the adapter, rather than by optional
        # argument text. Preserve normal model, permission, and prompt flags.
        adapter = CODING_ADAPTERS[tool]
        try:
            tokens = shlex.split(arguments)
        except ValueError:
            tokens = []  # Bash validated the syntax; expanded arguments are checked at launch.
        if adapter.selects_session(tokens):
            fail('Outpost controls the coding CLI session ID. Use Find conversations to resume one instead.')
        if action == 'fork':
            from outpost_worktrees import create_worktree

            # A Git failure must never allocate a coding conversation or session.
            try:
                create_worktree(source['rootDir'], path, branch)
            except (OSError, ValueError) as error:
                fail(str(error), 409)
            except subprocess.TimeoutExpired:
                fail('Git worktree creation timed out. Check the target before retrying.', 504)
        try:
            if request.get('cliSessionId'):
                requested_storage = request.get('cliSessionEnv', {})
                if requested_storage and not adapter.valid_storage(requested_storage):
                    fail('Invalid coding CLI storage directory')
                native = adapter.find(request['cliSessionId'], {**launch_environment, **requested_storage}, str(root))
                cli_id, cli_environment = native.id, native.storage
                if not native.root or Path(native.root).resolve() != root:
                    fail('Use the conversation’s working directory when linking it to a session.')
            else:
                cli_id, cli_environment = adapter.create(str(root), launch_environment, executable)
        except (ValueError, subprocess.TimeoutExpired) as error:
            message = str(error)
            if action == 'fork':
                message = 'Worktree created at ' + str(root) + ', but session creation failed: ' + message
            fail(message, 409)
        session = {
            'id': str(uuid.uuid4()),
            'name': name,
            'rootDir': str(root),
            'createdAt': now(),
            'lastConnectedAt': None,
            'tool': tool,
            'env': environment,
            'args': arguments,
            'cliSessionId': cli_id,
            'cliSessionEnv': cli_environment,
        }
        with registry_lock():
            # Re-read after slow external work; never overwrite concurrent
            # deletes, attachment timestamps, or other registry changes.
            data = read_registry()
            sessions = data['sessions']
            if any(s['name'].casefold() == name.casefold() for s in sessions):
                fail('A session with this name already exists on this target', 409)
            if any(
                s['tool'] == tool and s['cliSessionId'] == cli_id and s['cliSessionEnv'] == cli_environment
                for s in sessions
            ):
                fail('This conversation already has an Outpost session on this target.', 409)
            activity(session).initialize()
            sessions.append(session)
            if creation_key:
                data.setdefault('creations', {})[creation_key] = {
                    'fingerprint': fingerprint,
                    'sessionId': session['id'],
                }
            save(data)
        return describe(session)


def main():
    request = json.loads(base64.b64decode(sys.argv[1]))
    if not sys.platform.startswith('linux'):
        fail('Outpost targets must run Linux.', 409)
    action = request['action']
    if action == 'directories':
        # Discovery is read-only and independent of the session registry and lock.
        respond(directory_suggestions(request['path']))
        return
    if action == 'coding-search':
        from outpost_conversations import search as search_coding_sessions

        # Search never initializes the registry. Atomic registry replacement
        # makes this read safe without holding the lock through a long scan.
        sessions = read_registry()['sessions'] if STATE.is_dir() else []
        scopes = [(dict(os.environ, **{**s['env'], **s['cliSessionEnv']}), s['rootDir']) for s in sessions]
        try:
            result = search_coding_sessions(request['query'], request.get('tool'), scopes)
        except ValueError as error:
            fail(str(error))
        for match in result['sessions']:
            match['managedSessionIds'] = [
                s['id']
                for s in sessions
                if s['tool'] == match['tool']
                and s['cliSessionId'] == match['cliSessionId']
                and s['cliSessionEnv'] == match['cliSessionEnv']
            ]
        respond(result)
        return
    if action == 'create':
        if request.get('tool') not in CODING_ADAPTERS:
            fail('Unsupported coding tool.', 409)
        STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
        STATE.chmod(0o700)
    if not STATE.is_dir():
        if action == 'list':
            respond({'registryPath': str(REGISTRY), 'sessions': []})
            return
        fail('Session not found', 404)
    os.chdir(STATE)
    if action in ('create', 'fork'):
        respond(create_session(request))
        return
    if action in ('files-list', 'files-remove', 'files-read'):
        if not any(s['id'] == request.get('id') for s in read_registry()['sessions']):
            fail('Session not found', 404)
        try:
            if action == 'files-list':
                respond(outpost_files.list_files(request['id']))
            elif action == 'files-remove':
                outpost_files.remove(request['id'], request.get('fileId'))
                respond({'ok': True})
            else:
                metadata, stream = outpost_files.read_file(request['id'], request.get('fileId'))
                with stream:
                    sys.stdout.flush()
                    sys.stdout.buffer.write(b'OUTPOST_FILE:' + json.dumps(metadata).encode() + b'\n')
                    shutil.copyfileobj(stream, sys.stdout.buffer, 65536)
                    sys.stdout.buffer.flush()
        except FileNotFoundError:
            fail('Session file not found', 404)
        except ValueError as error:
            fail(str(error))
        return
    if action == 'upload-image':
        # Registry writes are atomic. Never hold its lock during file transfer.
        session = next((s for s in read_registry()['sessions'] if s['id'] == request.get('id')), None)
        if session is None:
            fail('Session not found', 404)
        respond(upload_image(session, request))
        return
    with registry_lock():
        data = read_registry()
        sessions = data['sessions']
        if action == 'list':
            result = {'registryPath': str(REGISTRY), 'sessions': [describe(s) for s in sessions]}
        else:
            session = next((s for s in sessions if s['id'] == request.get('id')), None)
            if session is None:
                fail('Session not found', 404)
            if action == 'get':
                result = describe(session)
            elif action == 'acknowledge':
                token = request.get('completionId')
                if not isinstance(token, str) or not re.fullmatch(r'[0-9a-f]{64}', token):
                    fail('Invalid completion ID')
                activity(session).acknowledge(token, alive(session))
                result = describe(session)
            elif action == 'terminate':
                result = terminate_session(session)
            elif action == 'delete':
                if alive(session):
                    fail('Terminate the session or exit the coding tool before deleting it.', 409)
                sessions.remove(session)
                save(data)
                Path(socket_name(session)).unlink(missing_ok=True)
                (STATE / 'logs' / (session['id'] + '.log')).unlink(missing_ok=True)
                activity(session).remove()
                outpost_files.remove_session(session['id'])
                result = {'ok': True}
            elif action == 'attach':
                cols, rows = terminal_size(request)
                if not isinstance(request.get('start'), bool):
                    fail('Invalid terminal start intent')
                terminal.command()
                if not alive(session):
                    if not request['start']:
                        fail('The coding tool exited. Click Reconnect to start it in the same conversation.', 410)
                    start_session(session, cols, rows)
                session['lastConnectedAt'] = now()
                save(data)
                result = None
            else:
                fail('Unknown operation')
    if action == 'attach':
        sys.exit(attach_session(session, cols, rows))
    respond(result)


if __name__ == '__main__':
    try:
        main()
    except terminal.TerminalUnavailable as error:
        fail(str(error), 409)
    except Exception as error:
        fail(str(error), 500)
