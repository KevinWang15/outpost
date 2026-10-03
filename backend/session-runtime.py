"""Executed locally or sent through SSH per request; never installed as an agent."""
import base64
import binascii
import ctypes
import datetime
import errno
import fcntl
import heapq
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import shlex
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from outpost_coding_protocol import adapters
from outpost_activity_state import Activity

CODING_ADAPTERS = adapters()

os.umask(0o077)
STATE = Path.home() / '.outpost'
REGISTRY = STATE / 'sessions.json'


def fail(message, status=400):
    print('OUTPOST_RESULT:' + json.dumps({'ok': False, 'error': {'message': message, 'status': status}}), flush=True)
    sys.exit(1)


def respond(data):
    print('OUTPOST_RESULT:' + json.dumps({'ok': True, 'data': data}), flush=True)


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def save(data):
    descriptor, temporary = tempfile.mkstemp(prefix='.sessions-', dir=STATE)
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


def read_registry():
    def text(value, limit):
        return isinstance(value, str) and 0 < len(value) <= limit and all(ord(c) >= 32 and ord(c) != 127 for c in value)

    def timestamp(value):
        return text(value, 80) and datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).tzinfo is not None

    try:
        data = json.loads(REGISTRY.read_text())
        if not isinstance(data, dict) or set(data) != {'sessions'} or not isinstance(data['sessions'], list):
            raise ValueError()
        ids, names, conversations = set(), set(), set()
        fields = {'id', 'name', 'rootDir', 'createdAt', 'lastConnectedAt', 'backend', 'tool', 'env', 'args',
                  'cliSessionId', 'cliSessionEnv'}
        for entry in data['sessions']:
            if not isinstance(entry, dict) or set(entry) != fields:
                raise ValueError()
            if not text(entry['id'], 36) or str(uuid.UUID(entry['id'])) != entry['id'] or entry['id'] in ids:
                raise ValueError()
            if entry['backend'] not in ('tmux', 'dtach') or entry['tool'] not in ('codex', 'kimi', 'claude'):
                raise ValueError()
            adapter = CODING_ADAPTERS[entry['tool']]
            if not adapter.valid_id(entry['cliSessionId']) or not adapter.valid_storage(entry['cliSessionEnv']):
                raise ValueError()
            if not valid_launch_options(entry['env'], entry['args']):
                raise ValueError()
            if not text(entry['name'], 80) or not entry['name'].strip():
                raise ValueError()
            if not text(entry['rootDir'], 4096) or not os.path.isabs(entry['rootDir']):
                raise ValueError()
            if not timestamp(entry['createdAt']) or (entry['lastConnectedAt'] is not None and not timestamp(entry['lastConnectedAt'])):
                raise ValueError()
            key = (entry['backend'], entry['name'].casefold())
            if key in names:
                raise ValueError()
            conversation = (entry['tool'], entry['cliSessionId'], tuple(sorted(entry['cliSessionEnv'].items())))
            if conversation in conversations:
                raise ValueError()
            ids.add(entry['id'])
            names.add(key)
            conversations.add(conversation)
        return data
    except (ValueError, TypeError, KeyError):
        fail('Invalid session registry. Expected the current schema; no data was modified.', 409)


def valid_launch_options(environment, arguments):
    if not isinstance(arguments, str) or len(arguments) > 8192 or '\0' in arguments:
        return False
    if not isinstance(environment, dict) or len(environment) > 32:
        return False
    if any(not isinstance(key, str) or len(key) > 128 or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key)
           or not isinstance(value, str) or len(value) > 4096 or '\0' in value for key, value in environment.items()):
        return False
    return len(json.dumps({'env': environment, 'args': arguments}, ensure_ascii=False, separators=(',', ':')).encode('utf-8')) <= 16 * 1024


def launch_script(session, executable):
    # Environment values and paths are literal; only the argument string is shell text.
    steps = ['cd -- ' + shlex.quote(session['rootDir'])]
    environment = {**session['env'], **session['cliSessionEnv']}
    if environment:
        steps.append('export -- ' + ' '.join(key + '=' + shlex.quote(value) for key, value in environment.items()))
    adapter = CODING_ADAPTERS[session['tool']]
    flags = ' '.join(shlex.quote(value) for value in adapter.arguments(session))
    # Bash expands the call's arguments once. The function checks that exact
    # argv and execs the CLI, preserving exec's behavior for shell operators.
    steps.append('launch_coding_tool() {\n' + adapter.argument_guard() + '\n'
                 + 'exec ' + shlex.quote(executable) + ' ' + flags + ' "$@"\n}')
    steps.append('launch_coding_tool ' + session['args'])
    return ' &&\n'.join(steps)


def socket_name(session):
    # Relative paths avoid the Unix socket path limit, even with long home directories.
    return 'sockets/' + session['id'] + '.sock'


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
                if len(candidate) > 4096 or any(ord(c) < 32 or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF for c in candidate):
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


def backend(session):
    value = session.get('backend')
    if value not in ('dtach', 'tmux'):
        fail('Unsupported session backend. Existing data was not modified.', 409)
    return value


def coding_tool(session):
    value = session.get('tool')
    if value not in ('codex', 'kimi', 'claude'):
        fail('Unsupported coding tool. Expected codex, kimi, or claude. Existing data was not modified.', 409)
    return value


def tmux_command(session, *arguments):
    return ['tmux', '-S', socket_name(session), '-f', '/dev/null', *arguments]


def tmux_environment():
    environment = dict(os.environ)
    environment.pop('TMUX', None)
    environment.pop('TMUX_PANE', None)
    return environment


def tmux_query(session, template):
    result = subprocess.run(tmux_command(session, 'display-message', '-p', '-t', '=outpost:', template),
                            capture_output=True, text=True, env=tmux_environment())
    if result.returncode or not result.stdout.strip():
        if not alive(session):
            return None
        fail('Could not read the tmux session: ' + result.stderr.strip(), 409)
    return result.stdout.strip()


def alive(session):
    connection = socket.socket(socket.AF_UNIX)
    connection.settimeout(1)
    try:
        connection.connect(socket_name(session))
        return True
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ECONNREFUSED):
            return False
        raise
    finally:
        connection.close()


def describe(session):
    status = 'stopped' if session['lastConnectedAt'] else 'idle'
    if alive(session):
        if backend(session) == 'tmux':
            clients = tmux_query(session, '#{session_attached}')
            if clients is not None:
                status = 'attached' if int(clients) else 'detached'
        else:
            try:
                status = 'attached' if os.stat(socket_name(session)).st_mode & stat.S_IXUSR else 'detached'
            except FileNotFoundError:
                pass
    return dict(session, status=status, socketPath=str(STATE / socket_name(session)),
                activity=activity(session).describe(status in ('attached', 'detached')))


def activity(session):
    return Activity(STATE / 'activity', CODING_ADAPTERS[session['tool']], session)


# Darwin exposes precise process birth times through libproc, rather than /proc.
# Field layout: Apple's bsd/sys/proc_info.h (proc_bsdinfo / PROC_PIDTBSDINFO).
if sys.platform == 'darwin':
    class BsdInfo(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint32) for name in (
            'flags', 'status', 'xstatus', 'pid', 'ppid', 'uid', 'gid', 'ruid',
            'rgid', 'svuid', 'svgid', 'reserved')] + [
            ('comm', ctypes.c_char * 16), ('name', ctypes.c_char * 32)] + [
            (name, ctypes.c_uint32) for name in ('nfiles', 'pgid', 'jobc', 'tdev', 'tpgid')] + [
            ('nice', ctypes.c_int32), ('seconds', ctypes.c_uint64), ('microseconds', ctypes.c_uint64)]
    libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    libproc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    libproc.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]


def process_executable(pid):
    if sys.platform == 'darwin':
        buffer = ctypes.create_string_buffer(4096)
        if libproc.proc_pidpath(pid, buffer, len(buffer)) <= 0:
            return ''
        return os.fsdecode(buffer.value)
    try:
        return os.readlink(Path('/proc', str(pid), 'exe'))
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return ''


def process_ids():
    if sys.platform == 'darwin':
        return [int(pid) for pid in subprocess.check_output(['ps', '-axo', 'pid='], text=True).split()]
    return [int(path.name) for path in Path('/proc').iterdir() if path.name.isdigit()]


def process_info(pid):
    if sys.platform == 'darwin':
        info = BsdInfo()
        if libproc.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info)) != ctypes.sizeof(info) or info.status == 5:
            return None
        return {'pid': pid, 'parent': info.ppid, 'start': (info.seconds, info.microseconds)}
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


def dtach_owner(session):
    # dtach binds before daemonizing, so SO_PEERCRED can report its exited
    # launcher. Find the live owner of the listening socket instead.
    names = {socket_name(session), str(STATE / socket_name(session))}
    if sys.platform == 'darwin':
        # Select dtach's Unix sockets, then verify the matching daemon's cwd.
        output = subprocess.run(['lsof', '-nP', '-a', '-U', '-c', 'dtach', '-Fpn'], capture_output=True, text=True)
        if output.returncode not in (0, 1):
            fail('Could not inspect dtach sockets: ' + output.stderr.strip(), 409)
        owners = {}
        pid = None
        for field in output.stdout.splitlines():
            if field.startswith('p'):
                pid = int(field[1:])
            elif field.startswith('n') and field[1:] in names and pid and os.path.basename(process_executable(pid)) == 'dtach':
                cwd = subprocess.run(['lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'], capture_output=True, text=True)
                directories = [line[1:] for line in cwd.stdout.splitlines() if line.startswith('n')]
                if any(os.path.samefile(directory, STATE) for directory in directories):
                    process = process_info(pid)
                    if process:
                        owners[pid] = process
        if len(owners) != 1:
            fail('Could not identify the live dtach process for this session. No processes were signaled.', 409)
        return next(iter(owners.values()))
    inodes = set()
    for line in Path('/proc/net/unix').read_text().splitlines()[1:]:
        fields = line.split(maxsplit=7)
        if len(fields) == 8 and fields[7] in names and int(fields[3], 16) & 0x10000:
            inodes.add('socket:[' + fields[6] + ']')
    owners = []
    for directory in Path('/proc').iterdir():
        if not directory.name.isdigit() or int(directory.name) <= 1:
            continue
        try:
            if os.path.basename(os.readlink(directory / 'exe')) not in ('dtach', 'dtach (deleted)'):
                continue
            if not os.path.samefile(directory / 'cwd', STATE):
                continue
            process = process_info(int(directory.name))
            if process and any(os.readlink(fd) in inodes for fd in (directory / 'fd').iterdir()):
                owners.append(process)
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    if len(owners) != 1:
        fail('Could not identify the live dtach process for this session. No processes were signaled.', 409)
    return owners[0]


def paste_image(session, request):
    extension = request.get('extension')
    if extension not in ('png', 'jpg', 'gif', 'webp'):
        fail('Invalid image upload request')
    max_bytes = 16 * 1024 * 1024
    max_encoded = ((max_bytes + 2) // 3) * 4
    encoded = sys.stdin.buffer.read(max_encoded + 2).strip()
    if len(encoded) > max_encoded:
        fail('Images are limited to 16 MB.', 413)
    try:
        data = base64.b64decode(encoded, validate=True)
    except binascii.Error:
        fail('Invalid image data')
    if not data or base64.b64encode(data) != encoded:
        fail('Invalid image data')
    if len(data) > max_bytes:
        fail('Images are limited to 16 MB.', 413)
    directory = STATE / 'clipboard' / session['id']
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / (datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S-%f-') + uuid.uuid4().hex + '.' + extension)
    with destination.open('xb') as stream:
        stream.write(data)
    # Keep only the newest uploads per session.
    for stale in sorted(directory.iterdir())[:-20]:
        try:
            stale.unlink()
        except OSError:
            pass
    reference = str(destination)
    injected = False
    # tmux paste-buffer writes to the pane directly; no attached client is
    # needed. dtach has no control channel, so its sessions stay manual.
    if backend(session) == 'tmux' and alive(session):
        # Bracketed paste delivers the reference as one paste, not as keystrokes.
        result = subprocess.run(tmux_command(session, 'set-buffer', '-b', 'outpost-image', '--', reference,
                                             ';', 'paste-buffer', '-p', '-d', '-b', 'outpost-image', '-t', '=outpost:'),
                                capture_output=True, text=True, env=tmux_environment())
        if result.returncode:
            fail('The image was saved to ' + str(destination) + ' but could not be pasted into the tmux session: ' + result.stderr.strip(), 409)
        injected = True
        activity(session).input()
    return {'path': str(destination), 'reference': reference, 'injected': injected}


def terminate_session(session):
    if not alive(session):
        Path(socket_name(session)).unlink(missing_ok=True)
        activity(session).initialize()
        return describe(session)
    if backend(session) == 'tmux':
        # Each managed session has its own server/socket, so this process tree
        # cannot include another manager session or the user's personal tmux.
        owner = tmux_query(session, '#{pid}')
        if owner is None:
            return describe(session)
        root = process_info(int(owner))
        if not root or os.path.basename(process_executable(int(owner))) not in ('tmux', 'tmux (deleted)'):
            fail('Could not identify the live tmux server. No processes were signaled.', 409)
    else:
        root = dtach_owner(session)
    processes = {}
    for pid in process_ids():
        process = process_info(pid)
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
    # where supported; older systems recheck /proc start times before signaling.
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


def attach_session(session):
    if backend(session) == 'tmux':
        # tmux restores its retained screen; it needs no synthetic resize.
        # Timed paste guessing can bypass the detach binding on a fast keypress
        # and send Ctrl-\ to the coding tool as SIGQUIT instead.
        # OSC 52 is the only clipboard channel that survives SSH: it travels
        # inside the terminal byte stream to the user's own terminal. Let panes
        # set it (set-clipboard on, passthrough for apps that DCS-wrap it) and
        # declare the capability for the outer terminal so tmux re-emits it.
        # Modified Enter (Shift+Enter newline) needs extended keys:
        # extended-keys=on forwards them to panes that requested them, extkeys
        # marks xterm* terminals as capable so tmux decodes them from the outer
        # terminal, and extended-keys-format pins the CSI u pane encoding on
        # tmux 3.5+ (3.4 already delivers CSI u; unknown options are ignored
        # via -q). terminal-features is an array: check before appending so
        # repeated attaches do not grow it.
        features = subprocess.run(tmux_command(session, 'show-options', '-gqv', 'terminal-features'),
                                  capture_output=True, text=True, env=tmux_environment())
        wanted = 'xterm*:clipboard:extkeys'
        chain = [] if features.returncode == 0 and wanted in features.stdout.split() \
            else [';', 'set-option', '-gaq', 'terminal-features', ',' + wanted]
        # tmux only honors a modifyOtherKeys request (CSI >4;2m), but kitty-only
        # tools (codex, claude) push the kitty protocol tmux cannot parse and
        # actively disable modifyOtherKeys at startup. Poke the request into the
        # pane tty from outside; tmux reads it as the app's own output. The
        # repeats outlast a slow tool startup, which would reset the mode again.
        pane_tty = subprocess.run(tmux_command(session, 'display-message', '-p', '-t', 'outpost', '#{pane_tty}'),
                                  capture_output=True, text=True, env=tmux_environment()).stdout.strip()
        if re.fullmatch(r'/dev/(pts/\d+|ttys\d+)', pane_tty):
            descriptor = None
            try:
                # Pin this tty before delaying: its pathname may be reused if
                # the session stops, but an open descriptor cannot target the
                # replacement terminal. Recheck ownership after opening it.
                descriptor = os.open(pane_tty, os.O_WRONLY | os.O_NOCTTY | os.O_NONBLOCK)
                current = subprocess.run(tmux_command(session, 'display-message', '-p', '-t', '=outpost:', '#{pane_tty}'),
                                         capture_output=True, text=True, env=tmux_environment())
                if current.returncode == 0 and current.stdout.strip() == pane_tty:
                    # Use one inherited descriptor for every delayed write.
                    pokes = 'exec 3>&' + str(descriptor) + '; ' + '; '.join(
                        'sleep ' + str(delay) + '; printf "\\033[>4;2m" >&3 || exit'
                        for delay in (1, 2, 3))
                    subprocess.Popen(['bash', '-c', pokes], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL, env=tmux_environment(), start_new_session=True,
                                     pass_fds=(descriptor,))
            except OSError:
                # A disappearing pane must not prevent attachment or write to
                # another terminal. The next attachment can retry negotiation.
                pass
            finally:
                if descriptor is not None:
                    os.close(descriptor)
        command = tmux_command(session, 'set-option', '-g', 'assume-paste-time', '0',
                                       ';', 'set-option', '-gq', 'set-clipboard', 'on',
                                       ';', 'set-option', '-gq', 'allow-passthrough', 'on',
                                       ';', 'set-option', '-gq', 'extended-keys', 'on',
                                       ';', 'set-option', '-gq', 'extended-keys-format', 'csi-u',
                                       ';', 'set-option', '-gq', 'focus-events', 'on',
                                       *chain,
                                       ';', 'attach-session', '-t', '=outpost')
    else:
        command = ['dtach', '-a', socket_name(session), '-r', 'winch', '-e', '^\\']
    from outpost_terminal_attachment import attach
    observer = activity(session)
    try:
        observer.input()  # Returning to this terminal checks the existing completion.
    except (OSError, ValueError):
        pass  # Missing activity signals must not prevent terminal attachment.
    return attach(command, tmux_environment(), observer.input, repaint=backend(session) == 'dtach')


def main():
    request = json.loads(base64.b64decode(sys.argv[1]))
    context = request.get('context')
    if context and (context['home'] != str(Path.home()) or context['uid'] != os.getuid()):
        fail('Run this local connection on the manager computer as the user who initialized this target.', 409)
    action = request['action']
    if action == 'directories':
        # Discovery is read-only and independent of the session registry and lock.
        respond(directory_suggestions(request['path']))
        return
    if action == 'coding-search':
        from outpost_coding_sessions import search as search_coding_sessions
        # Search is independent of persistence-tool state and never initializes
        # the registry. Atomic registry replacement makes this read safe without
        # holding its lock through a potentially large transcript scan.
        sessions = read_registry()['sessions'] if REGISTRY.exists() else []
        scopes = [(dict(os.environ, **{**s['env'], **s['cliSessionEnv']}), s['rootDir']) for s in sessions]
        try:
            result = search_coding_sessions(request['query'], request.get('tool'), scopes)
        except ValueError as error:
            fail(str(error))
        for match in result['sessions']:
            match['managedSessionIds'] = [s['id'] for s in sessions if s['tool'] == match['tool']
                                         and s['cliSessionId'] == match['cliSessionId']
                                         and s['cliSessionEnv'] == match['cliSessionEnv']]
        respond(result)
        return
    if action == 'create':
        selected_backend = backend(request)
        STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
        (STATE / 'sockets').mkdir(mode=0o700, exist_ok=True)
        STATE.chmod(0o700)
    if not STATE.is_dir() or not REGISTRY.exists():
        if action == 'list':
            respond({'registryPath': str(REGISTRY), 'sessions': []})
            return
        if action != 'create':
            fail('Session not found', 404)
    os.chdir(STATE)
    with open(STATE / 'registry.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not REGISTRY.exists():
            save({'sessions': []})
        data = read_registry()
        sessions = data['sessions']
        if action == 'list':
            result = {'registryPath': str(REGISTRY), 'sessions': [describe(s) for s in sessions]}
        elif action == 'create':
            tool = coding_tool(request)
            environment, arguments = request['env'], request['args']
            if not valid_launch_options(environment, arguments):
                fail('Invalid environment variables or arguments')
            syntax = subprocess.run(['bash', '-n', '-c', 'exec "$1" ' + arguments], capture_output=True, text=True)
            if syntax.returncode:
                fail('Invalid Bash argument syntax: ' + syntax.stderr.strip())
            name = request['name'].strip()
            if any(s['backend'] == selected_backend and s['name'].casefold() == name.casefold() for s in sessions):
                fail('A session with this name already exists for this backend on this target', 409)
            path = os.path.expanduser(request['rootDir'])
            if not os.path.isabs(path):
                fail('Root directory must be absolute or begin with ~/')
            root = Path(path).resolve()
            if request.get('createDirectory'):
                root.mkdir(parents=True, exist_ok=True)
            if not root.is_dir():
                fail('Root directory does not exist. Enable Create directory or choose an existing directory.')
            launch_environment = dict(os.environ, **environment)
            executable = shutil.which(tool, path=launch_environment.get('PATH'))
            if not executable:
                fail(tool + ' is missing on this target. Check Required Software and your login PATH.', 409)
            # CLI identity is owned by the adapter, rather than by optional
            # argument text. Preserve normal model, permission, and prompt flags.
            adapter = CODING_ADAPTERS[tool]
            try:
                tokens = shlex.split(arguments)
            except ValueError:
                # Bash syntax was validated above; shlex only catches literal
                # selectors early. Expanded arguments are checked at launch.
                tokens = []
            if adapter.selects_session(tokens):
                fail('The manager controls the coding CLI session ID. Use the session finder to resume a conversation instead of session-selection arguments.')
            try:
                if request.get('cliSessionId'):
                    requested_storage = request.get('cliSessionEnv', {})
                    if requested_storage and not adapter.valid_storage(requested_storage):
                        fail('Invalid coding CLI storage directory')
                    native = adapter.find(request['cliSessionId'], {**launch_environment, **requested_storage}, str(root))
                    cli_id, cli_environment = native.id, native.storage
                    if not native.root or Path(native.root).resolve() != root:
                        fail('Use the conversation’s working directory when linking it to a manager session.')
                else:
                    cli_id, cli_environment = adapter.create(str(root), launch_environment, executable)
            except (ValueError, subprocess.TimeoutExpired) as error:
                fail(str(error), 409)
            if any(s['tool'] == tool and s['cliSessionId'] == cli_id and s['cliSessionEnv'] == cli_environment for s in sessions):
                fail('This coding CLI conversation already has a manager session on this target.', 409)
            session = {'id': str(uuid.uuid4()), 'name': name, 'rootDir': str(root),
                       'createdAt': now(), 'lastConnectedAt': None, 'backend': selected_backend, 'tool': tool,
                       'env': environment, 'args': arguments, 'cliSessionId': cli_id, 'cliSessionEnv': cli_environment}
            activity(session).initialize()
            data['sessions'].append(session)
            save(data)
            result = describe(session)
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
            elif action == 'paste-image':
                result = paste_image(session, request)
            elif action == 'terminate':
                result = terminate_session(session)
            elif action == 'delete':
                if alive(session):
                    fail('Terminate the session or exit the coding tool before deleting this session.', 409)
                data['sessions'].remove(session)
                save(data)
                Path(socket_name(session)).unlink(missing_ok=True)
                activity(session).remove()
                result = {'ok': True}
            elif action == 'attach':
                if not shutil.which(backend(session)):
                    fail(backend(session) + ' is missing on this target. Open Required Software to install it.', 409)
                if not alive(session):
                    if not Path(session['rootDir']).is_dir():
                        fail('Session root directory no longer exists', 409)
                    tool = coding_tool(session)
                    executable = shutil.which(tool, path=session['env'].get('PATH', os.environ.get('PATH')))
                    if not executable:
                        fail(tool + " is not on " + pwd.getpwuid(os.getuid()).pw_name + "'s interactive login PATH. Check that user's shell startup files before connecting.", 409)
                    Path(socket_name(session)).unlink(missing_ok=True)
                    command_shell = shutil.which('bash')
                    if not command_shell:
                        fail('Bash is missing on this target. Open Required Software to install it.', 409)
                    activity(session).initialize()
                    launch = [command_shell, '-c', launch_script(session, executable)]
                    # The persistence tool owns the PTY independently of SSH.
                    if backend(session) == 'tmux':
                        size = os.get_terminal_size()
                        command = tmux_command(session, 'new-session', '-d', '-s', 'outpost',
                                               '-c', session['rootDir'], '-x', str(max(1, size.columns)),
                                               '-y', str(max(1, size.lines)), *launch,
                                               ';', 'set-option', '-g', 'status', 'off',
                                               ';', 'bind-key', '-n', 'C-\\', 'detach-client')
                    else:
                        command = ['dtach', '-n', socket_name(session), '-r', 'winch',
                                   *launch]
                    subprocess.run(command, check=True, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=tmux_environment())
                    for _ in range(50):
                        if alive(session):
                            break
                        time.sleep(0.02)
                    else:
                        fail(tool + ' exited before attachment. Check its configuration.', 409)
                session['lastConnectedAt'] = now()
                save(data)
                result = None
            else:
                fail('Unknown operation')
    if action == 'attach':
        sys.exit(attach_session(session))
    else:
        respond(result)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        fail(str(error), 500)
