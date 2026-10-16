"""Framed attachment relay: the target end of one terminal connection.

stdin and stdout carry relay-protocol frames (docs/ARCHITECTURE.md). The relay
connects to the session service over a Unix socket. Closing the relay never
closes the persistent PTY or its process.
"""

import fcntl
import json
import os
import re
import select
import signal
import socket
import time
import uuid

from outpost_activity_stream import ActivityStream
from outpost_frames import MAGIC, FrameDecoder, control, encode

MAX_SIGNAL = 32 * 1024
HIGH_WATER = 256 * 1024


class SignalClient:
    def __init__(self, connection):
        self.connection = connection
        self.buffer = b''
        self.id = None
        self.deadline = time.monotonic() + 12


class SignalServer:
    """Unix socket for outpost-signal helpers. The newest relay of a session owns
    the path, so signals reach the terminal you most recently connected."""

    def __init__(self, path):
        self.path = path
        self.clients = {}
        directory = os.path.dirname(path)
        os.makedirs(directory, mode=0o700, exist_ok=True)
        os.chmod(directory, 0o700)
        temporary = path + '.' + uuid.uuid4().hex[:8]
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.bind(temporary)
        os.chmod(temporary, 0o600)
        self.socket.listen(16)
        self.socket.setblocking(False)
        os.replace(temporary, path)
        self.inode = os.stat(path).st_ino

    def accept(self):
        try:
            connection, _ = self.socket.accept()
        except (BlockingIOError, InterruptedError):
            return
        if len(self.clients) >= 16:
            self.reply_to(connection, {'ok': False, 'message': 'Too many pending signals.'})
            return
        connection.setblocking(False)
        self.clients[connection.fileno()] = SignalClient(connection)

    def read(self, descriptor):
        """Return (client, request) once a full request line has arrived."""
        client = self.clients[descriptor]
        try:
            data = client.connection.recv(MAX_SIGNAL + 1)
        except (BlockingIOError, InterruptedError):
            return None
        except OSError:
            data = b''
        if not data:
            self.drop(descriptor)
            return None
        client.buffer += data
        if b'\n' not in client.buffer:
            if len(client.buffer) > MAX_SIGNAL:
                self.reply(descriptor, {'ok': False, 'message': 'Signals must fit within 32 KiB.'})
            return None
        line = client.buffer.split(b'\n', 1)[0]
        client.buffer = b''
        try:
            request = json.loads(line)
            if not isinstance(request, dict) or not isinstance(request.get('type'), str) or 'payload' not in request:
                raise ValueError()
        except ValueError:
            self.reply(descriptor, {'ok': False, 'message': 'Invalid signal request.'})
            return None
        client.id = uuid.uuid4().hex
        return client, {'type': request['type'], 'payload': request['payload']}

    def answer(self, signal_id, message):
        for descriptor, client in list(self.clients.items()):
            if client.id == signal_id:
                self.reply(descriptor, message)

    def expire(self):
        for descriptor, client in list(self.clients.items()):
            if time.monotonic() > client.deadline:
                self.reply(descriptor, {'ok': False, 'message': 'Outpost did not respond in time.'})

    @staticmethod
    def reply_to(connection, message):
        try:
            connection.setblocking(True)
            connection.settimeout(1)
            connection.sendall(json.dumps(message).encode() + b'\n')
        except OSError:
            pass
        finally:
            connection.close()

    def reply(self, descriptor, message):
        client = self.clients.pop(descriptor, None)
        if client:
            self.reply_to(client.connection, message)

    def drop(self, descriptor):
        client = self.clients.pop(descriptor, None)
        if client:
            client.connection.close()

    def close(self):
        for descriptor in list(self.clients):
            self.reply(descriptor, {'ok': False, 'message': 'The Outpost terminal disconnected.'})
        self.socket.close()
        try:
            if os.stat(self.path).st_ino == self.inode:
                os.unlink(self.path)
        except FileNotFoundError:
            pass


class Relay:
    """Disposable socket adapter. The service owns the PTY and its lifetime."""

    def __init__(self, path, cols, rows, hooks, signal_path=None):
        self.path, self.cols, self.rows = path, cols, rows
        self.hooks, self.signal_path = hooks, signal_path
        self.outgoing = bytearray()
        self.incoming = bytearray()
        self.stopped = False

    def send(self, message):
        self.outgoing += control(message)

    def observed(self, data):
        # Frames preserve each renderer input event. Only focus reports are
        # automatic; the headless service owns all terminal query replies.
        if not data or data in (b'\x1b[I', b'\x1b[O'):
            return
        try:
            self.hooks.on_input()
        except (OSError, ValueError):
            pass

    def handle(self, kind, payload):
        if kind == b'I':
            self.observed(payload)
            self.incoming += encode(kind, payload)
            return
        if kind != b'C':
            raise ValueError('Unknown relay frame')
        message = json.loads(payload)
        action = message.get('type')
        if action in ('resize', 'focus', 'send', 'clear'):
            if action == 'send':
                self.observed(message['data'].encode())
            self.incoming += control(message)
        elif action == 'paste-image':
            try:
                result = self.hooks.paste_image(message.get('extension'), message.get('data'))
                # Image paths share the same FIFO as typed input and drafts.
                self.incoming += control(
                    {
                        'type': 'paste',
                        'id': message['id'],
                        'data': result['reference'],
                        'reference': result['reference'],
                    }
                )
                self.observed(result['reference'].encode())
            except (OSError, ValueError) as error:
                self.send({'type': 'result', 'id': message.get('id'), 'ok': False, 'message': str(error)})
        elif action == 'acknowledge':
            identifier, completion_id = message.get('id'), message.get('completionId')
            valid = (
                isinstance(identifier, str)
                and re.fullmatch(r'[A-Za-z0-9_-]{1,80}', identifier)
                and isinstance(completion_id, str)
                and re.fullmatch(r'[a-f0-9]{64}', completion_id)
            )
            if not valid or not self.activity.request_acknowledgement(identifier, completion_id):
                self.send({'type': 'result', 'id': identifier, 'ok': False, 'message': 'Activity check unavailable.'})
        elif action == 'signal-result' and self.signals:
            self.signals.answer(message.get('id'), {'ok': message.get('ok') is True, 'message': message.get('message')})

    def run(self):
        from outpost_terminal import PROTOCOL

        service = socket.socket(socket.AF_UNIX)
        service.connect(self.path)
        service.setblocking(False)
        self.incoming += control({'type': 'attach', 'protocol': PROTOCOL, 'cols': self.cols, 'rows': self.rows})
        self.activity = ActivityStream(self.hooks.activity, self.hooks.acknowledge)
        self.signals = None
        if self.signal_path:
            try:
                self.signals = SignalServer(self.signal_path)
            except OSError:
                pass
        decoder = FrameDecoder()
        service_decoder = FrameDecoder()
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
            while not self.stopped and (not eof or self.outgoing):
                if len(self.outgoing) < HIGH_WATER:
                    state = self.activity.poll()
                    if state is not None:
                        self.send({'type': 'activity', 'activity': state})
                    for result in self.activity.take_results():
                        self.send(result)
                readers = [] if eof or len(self.outgoing) >= HIGH_WATER else [service.fileno()]
                if len(self.incoming) < HIGH_WATER:
                    readers.append(0)
                if self.signals:
                    self.signals.expire()
                    readers += [self.signals.socket.fileno(), *self.signals.clients]
                writers = ([service.fileno()] if self.incoming and not eof else []) + ([1] if self.outgoing else [])
                ready, writable, _ = select.select(readers, writers, [], 0.05)
                for descriptor in ready:
                    if self.signals and descriptor == self.signals.socket.fileno():
                        self.signals.accept()
                        continue
                    if self.signals and descriptor in self.signals.clients:
                        received = self.signals.read(descriptor)
                        if received:
                            client, request = received
                            self.send({'type': 'signal', 'id': client.id, 'signal': request})
                        continue
                    try:
                        data = os.read(descriptor, 65536)
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
                            self.handle(kind, payload)
                    else:
                        for kind, payload in service_decoder.feed(data):
                            self.outgoing += encode(kind, payload)
                for descriptor in writable:
                    buffer = self.outgoing if descriptor == 1 else self.incoming
                    try:
                        del buffer[: os.write(descriptor, buffer)]
                    except BlockingIOError:
                        pass
                    except (BrokenPipeError, ConnectionResetError):
                        self.stopped = True
        finally:
            service.close()
            self.activity.close()
            if self.signals:
                self.signals.close()
            for sig, handler in handlers.items():
                signal.signal(sig, handler)
            for descriptor, value in flags.items():
                fcntl.fcntl(descriptor, fcntl.F_SETFL, value)
        return 0
