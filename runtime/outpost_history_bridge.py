"""A private MCP control connection independent of terminal/chat viewers."""

import fcntl
import json
import os
import re
import select
import socket
import time
import uuid
from pathlib import Path

from outpost_frames import MAGIC, FrameDecoder, control
from outpost_storage import replace_file

MAX_REQUEST = 65536
MAX_RESPONSE = 4 * 1024 * 1024


def socket_path(value):
    if not isinstance(value, str) or not re.fullmatch(r'run/history-[0-9a-f]{32}\.sock', value):
        raise ValueError('Invalid Outpost history connection')
    return value


def bind_session(state, session, path):
    """The launcher, never a tool argument, binds a session to its account."""
    socket_path(path)
    directory = state / 'history-bindings'
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    destination = directory / (session + '.json')
    replace_file(destination, json.dumps({'socket': path}))


class Bridge:
    def __init__(self, state, path, valid_session):
        self.state, self.path, self.valid_session = state, socket_path(path), valid_session
        self.clients = {}
        self.outgoing = bytearray(MAGIC)

    def reply(self, identifier, result):
        client = self.clients.pop(identifier, None)
        if not client:
            return
        try:
            body = json.dumps(result, ensure_ascii=False).encode() + b'\n'
            if len(body) > MAX_RESPONSE:
                body = b'{"ok":false,"message":"History response exceeded its limit; request a smaller page."}\n'
            client['socket'].setblocking(True)
            client['socket'].settimeout(1)
            client['socket'].sendall(body)
        except OSError:
            pass
        finally:
            client['socket'].close()

    def run(self):
        os.chdir(self.state)
        Path('run').mkdir(mode=0o700, exist_ok=True)
        temporary = self.path + '.' + uuid.uuid4().hex[:8]
        listener = socket.socket(socket.AF_UNIX)
        listener.bind(temporary)
        os.chmod(temporary, 0o600)
        listener.listen(16)
        listener.setblocking(False)
        os.replace(temporary, self.path)
        inode = os.stat(self.path).st_ino
        decoder = FrameDecoder()
        flags = {fd: fcntl.fcntl(fd, fcntl.F_GETFL) for fd in (0, 1)}
        try:
            for fd in flags:
                fcntl.fcntl(fd, fcntl.F_SETFL, flags[fd] | os.O_NONBLOCK)
            while True:
                for identifier, client in list(self.clients.items()):
                    if time.monotonic() > client['deadline']:
                        self.reply(
                            identifier,
                            {'ok': False, 'message': 'History search timed out. Retry with a smaller query.'},
                        )
                readers = [
                    0,
                    listener.fileno(),
                    *[c['socket'].fileno() for c in self.clients.values() if not c['sent']],
                ]
                ready, writable, _ = select.select(readers, [1] if self.outgoing else [], [], 0.2)
                if 1 in writable:
                    try:
                        del self.outgoing[: os.write(1, self.outgoing)]
                    except BlockingIOError:
                        pass
                if 0 in ready:
                    data = os.read(0, 65536)
                    if not data:
                        break
                    for kind, payload in decoder.feed(data):
                        if kind != b'C':
                            raise ValueError('Invalid history control frame')
                        result = json.loads(payload)
                        if result.get('type') == 'result':
                            self.reply(result.get('id'), result)
                if listener.fileno() in ready:
                    connection, _ = listener.accept()
                    connection.setblocking(False)
                    identifier = uuid.uuid4().hex
                    self.clients[identifier] = {
                        'socket': connection,
                        'data': b'',
                        'deadline': time.monotonic() + 55,
                        'sent': False,
                    }
                    if len(self.clients) > 16:
                        self.reply(identifier, {'ok': False, 'message': 'Too many pending history calls.'})
                for identifier, client in list(self.clients.items()):
                    if client['sent'] or client['socket'].fileno() not in ready:
                        continue
                    try:
                        data = client['socket'].recv(MAX_REQUEST + 1)
                        if not data:
                            self.reply(identifier, {'ok': False, 'message': 'History request disconnected.'})
                            continue
                        client['data'] += data
                        if len(client['data']) > MAX_REQUEST:
                            raise ValueError('History request is too large')
                        if b'\n' not in client['data']:
                            continue
                        request = json.loads(client['data'].split(b'\n', 1)[0])
                        if not isinstance(request, dict) or not self.valid_session(request.get('sessionId')):
                            raise ValueError('This Outpost session is no longer available')
                        frame = control(
                            {
                                'type': 'call',
                                'id': identifier,
                                **{key: request.get(key) for key in ('sessionId', 'tool', 'arguments')},
                            }
                        )
                        if len(self.outgoing) + len(frame) > 2 * 1024 * 1024:
                            raise ValueError('Outpost history is busy. Retry shortly.')
                        client['sent'] = True
                        self.outgoing += frame
                    except (OSError, ValueError, TypeError) as error:
                        self.reply(identifier, {'ok': False, 'message': str(error)})
        finally:
            for identifier in list(self.clients):
                self.reply(
                    identifier, {'ok': False, 'message': 'The Outpost history connection is restarting. Retry shortly.'}
                )
            listener.close()
            try:
                if os.stat(self.path).st_ino == inode:
                    os.unlink(self.path)
            except FileNotFoundError:
                pass
            for fd, value in flags.items():
                fcntl.fcntl(fd, fcntl.F_SETFL, value)
