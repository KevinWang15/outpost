"""Chat mode: a session driven by `outpost-terminal chat-serve` over ACP.

A managed session's native conversation has one driver at a time: the terminal
service (a PTY running the CLI) or the chat host (the CLI's Agent Client
Protocol server). Both continue the same native conversation.
"""

import errno
import fcntl
import json
import os
import select
import signal
import socket
import subprocess
import time
from pathlib import Path

import outpost_terminal as terminal
from outpost_frames import MAGIC, FrameDecoder, control, encode
from outpost_storage import replace_file

PROTOCOL = 2
MAX_INSTRUCTIONS = 32000


def socket_name(session):
    # Relative to the state directory; see outpost_runtime.socket_name.
    return 'chats/' + session['id'] + '.sock'


def status(session):
    """The chat host's status, or None when no host is running."""
    try:
        result = terminal.request(socket_name(session), {'type': 'status'})
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ECONNREFUSED):
            return None
        raise
    if result.get('type') != 'status':
        raise ValueError('Invalid chat host status')
    return result


def acknowledge(session, completion_id):
    try:
        terminal.request(socket_name(session), {'type': 'seen', 'completionId': completion_id})
    except OSError as error:
        if error.errno not in (errno.ENOENT, errno.ECONNREFUSED):
            raise


def settings_path(state, session):
    return state / 'chats' / (session['id'] + '.json')


def read_settings(state, session):
    try:
        data = json.loads(settings_path(state, session).read_text())
    except FileNotFoundError:
        return {'instructions': None}
    except ValueError:
        raise ValueError('Invalid chat settings for this session. No data was modified.') from None
    if (
        not isinstance(data, dict)
        or set(data) != {'instructions'}
        or not (
            data['instructions'] is None
            or (isinstance(data['instructions'], str) and len(data['instructions']) <= MAX_INSTRUCTIONS)
        )
    ):
        raise ValueError('Invalid chat settings for this session. No data was modified.')
    return data


def write_settings(state, session, instructions):
    if instructions is not None and (not isinstance(instructions, str) or len(instructions) > MAX_INSTRUCTIONS):
        raise ValueError('Instructions must be text of at most 32,000 characters.')
    instructions = instructions.strip() if instructions else None
    path = settings_path(state, session)
    path.parent.mkdir(mode=0o700, exist_ok=True)
    replace_file(path, json.dumps({'instructions': instructions or None}) + '\n')
    return {'instructions': instructions or None}


def remove(state, session):
    for path in (settings_path(state, session), state / 'logs' / (session['id'] + '.chat.log')):
        path.unlink(missing_ok=True)
    Path(socket_name(session)).unlink(missing_ok=True)


def start(state, session, adapter, executable, environment, servers):
    """Start the chat host; it opens the native conversation asynchronously.
    servers are the launch's MCP servers (outpost_mcp_servers.servers)."""
    (state / 'chats').mkdir(mode=0o700, exist_ok=True)
    Path(socket_name(session)).unlink(missing_ok=True)
    command, additions = adapter.chat_command(state, executable)
    environment = {**environment, **additions}
    launch = {
        'socket': socket_name(session),
        'session': session['id'],
        'command': command,
        'cwd': session['rootDir'],
        'env': environment,
        'resume': session['cliSessionId'] if adapter.chat_resumable(session) else None,
        'mcpServers': adapter.chat_mcp_servers(state, session, servers),
        'instructions': read_settings(state, session)['instructions'],
    }
    logs = state / 'logs'
    logs.mkdir(mode=0o700, exist_ok=True)
    log = logs / (session['id'] + '.chat.log')
    with log.open('wb') as output:
        process = subprocess.Popen(
            [terminal.command(), 'chat-serve'],
            stdin=subprocess.PIPE,
            stdout=output,
            stderr=output,
            cwd=state,
            start_new_session=True,
        )
        process.stdin.write(json.dumps(launch).encode())
        process.stdin.close()
        for _ in range(200):
            if process.poll() is not None:
                raise ValueError('The chat could not start: ' + log_tail(log))
            if status(session) is not None:
                return
            time.sleep(0.05)
        process.terminate()
        raise ValueError('The chat did not start. Open Required Software to reinstall Outpost Terminal.')


def log_tail(log):
    try:
        text = log.read_text(errors='replace').strip()
    except OSError:
        return 'no diagnostics were recorded.'
    lines = [line for line in text.splitlines() if line.startswith('outpost chat: ')]
    return (lines[-1][len('outpost chat: ') :] if lines else text[-2000:]) or 'no diagnostics were recorded.'


class Relay:
    """Forward chat frames between the broker (stdio) and the session's chat host.

    The relay that sees a new conversation's identity first records it in the
    session registry, then lets the host accept prompts.
    """

    def __init__(self, state, session, persist_identity):
        self.state = state
        self.session = session
        self.persist_identity = persist_identity
        self.outgoing = bytearray()
        self.incoming = bytearray()
        self.stopped = False

    def intercept(self, payload):
        try:
            message = json.loads(payload)
        except ValueError:
            return
        if message.get('type') != 'identity' or not isinstance(message.get('nativeId'), str):
            return
        try:
            self.persist_identity(message['nativeId'])
        except ValueError as error:
            self.outgoing += control({'type': 'error', 'message': str(error)})
            self.stopped = True
            return
        self.incoming += control({'type': 'identity-saved', 'nativeId': message['nativeId']})

    def run(self):
        host = socket.socket(socket.AF_UNIX)
        try:
            host.connect(socket_name(self.session))
        except OSError as error:
            if error.errno in (errno.ENOENT, errno.ECONNREFUSED):
                raise ValueError(
                    'The chat stopped: ' + log_tail(self.state / 'logs' / (self.session['id'] + '.chat.log'))
                ) from None
            raise
        host.setblocking(False)
        decoder, host_decoder = FrameDecoder(), FrameDecoder()
        handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGPIPE)}
        flags = {descriptor: fcntl.fcntl(descriptor, fcntl.F_GETFL) for descriptor in (0, 1)}
        eof = False

        def stop(_sig, _frame):
            self.stopped = True

        try:
            os.write(1, MAGIC)
            for descriptor in (0, 1):
                fcntl.fcntl(descriptor, fcntl.F_SETFL, flags[descriptor] | os.O_NONBLOCK)
            signal.signal(signal.SIGHUP, stop)
            signal.signal(signal.SIGTERM, stop)
            signal.signal(signal.SIGPIPE, signal.SIG_IGN)
            limit = 8 * 1024 * 1024
            while not self.stopped and (not eof or self.outgoing):
                readers = [] if eof or len(self.outgoing) >= limit else [host.fileno()]
                if len(self.incoming) < limit:
                    readers.append(0)
                writers = ([host.fileno()] if self.incoming and not eof else []) + ([1] if self.outgoing else [])
                ready, writable, _ = select.select(readers, writers, [], 1)
                for descriptor in ready:
                    try:
                        data = os.read(descriptor, 262144)
                    except BlockingIOError:
                        continue
                    if not data:
                        if descriptor == 0:
                            self.stopped = True
                        else:
                            eof = True
                        continue
                    if descriptor == 0:
                        for kind, payload in decoder.feed(data):
                            if kind != b'C':
                                raise ValueError('Invalid chat frame')
                            self.incoming += encode(kind, payload)
                    else:
                        for kind, payload in host_decoder.feed(data):
                            self.intercept(payload)
                            self.outgoing += encode(kind, payload)
                for descriptor in writable:
                    buffer = self.outgoing if descriptor == 1 else self.incoming
                    try:
                        del buffer[: os.write(descriptor, buffer)]
                    except BlockingIOError:
                        pass
                    except (BrokenPipeError, ConnectionResetError):
                        self.stopped = True
            # Deliver a final error frame to the broker before closing.
            if self.outgoing:
                fcntl.fcntl(1, fcntl.F_SETFL, flags[1])
                os.write(1, bytes(self.outgoing))
        finally:
            host.close()
            for sig, handler in handlers.items():
                signal.signal(sig, handler)
            for descriptor, value in flags.items():
                fcntl.fcntl(descriptor, fcntl.F_SETFL, value)
        return 0
