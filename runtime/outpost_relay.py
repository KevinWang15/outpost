"""Framed attachment relay: the target end of one terminal connection.

stdin and stdout carry relay-protocol frames (docs/ARCHITECTURE.md). The relay
owns the PTY for `tmux attach`; persistence belongs to tmux. When this process
ends, only the tmux client detaches.
"""

import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import socket
import struct
import termios
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

MAGIC = b'\x00OUTPOST-RELAY-2\x00'
HEADER = struct.Struct('>cI')
MAX_FRAME = 32 * 1024 * 1024
MAX_SIGNAL = 32 * 1024
HIGH_WATER = 256 * 1024


def encode(kind, payload):
    return HEADER.pack(kind, len(payload)) + payload


def control(message):
    return encode(b'C', json.dumps(message, separators=(',', ':')).encode())


class FrameDecoder:
    def __init__(self):
        self.buffer = bytearray()

    def feed(self, data):
        self.buffer += data
        frames = []
        while len(self.buffer) >= HEADER.size:
            kind, length = HEADER.unpack_from(self.buffer)
            if length > MAX_FRAME:
                raise ValueError('Relay frame exceeds its size limit')
            end = HEADER.size + length
            if len(self.buffer) < end:
                break
            frames.append((kind, bytes(self.buffer[HEADER.size : end])))
            del self.buffer[:end]
        return frames


class InputObserver:
    """Ignore automatic terminal replies; acknowledge actual input and focus-in."""

    replies = re.compile(rb'\x1b\[(?:[?>]?[0-9;]*[cRn]|\?[0-9;]*u|\??[0-9;]*\$y|O)$')

    def __init__(self, callback):
        self.callback = callback
        self.pending = b''
        self.deadline = 0

    def feed(self, data):
        data = self.pending + data
        self.pending = b''
        while data:
            if data.startswith(b'\x1b['):
                match = re.match(rb'\x1b\[[0-?]*[ -/]*[@-~]', data)
                if match:
                    sequence = match.group()
                    if not self.replies.fullmatch(sequence):
                        self.callback()
                    data = data[len(sequence) :]
                    continue
                if len(data) < 256:
                    self.pending, self.deadline = data, time.monotonic() + 0.1
                    return
            elif data.startswith(b'\x1b]'):
                match = re.match(rb'\x1b\].*?(?:\x07|\x1b\\)', data, re.DOTALL)
                if match:
                    data = data[len(match.group()) :]
                    continue
                if len(data) < 4096:
                    self.pending, self.deadline = data, time.monotonic() + 0.1
                    return
            elif data == b'\x1b':
                self.pending, self.deadline = data, time.monotonic() + 0.1
                return
            self.callback()
            return

    def flush(self):
        if self.pending and time.monotonic() >= self.deadline:
            self.pending = b''
            self.callback()


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


def winsize(cols, rows):
    return struct.pack('HHHH', rows, cols, 0, 0)


class Relay:
    """hooks: on_input(), paste_image(extension, data), optional scrollback(offset)."""

    def __init__(self, command, environment, cols, rows, hooks, signal_path=None):
        self.command = command
        self.environment = environment
        self.size = winsize(cols, rows)
        self.hooks = hooks
        self.signal_path = signal_path
        self.incoming = bytearray()
        self.outgoing = bytearray()
        self.tail = b''
        self.stopped = False
        self.history_subscribed = False
        self.history_dirty = False
        self.history_offset = None
        self.history_checked = 0
        self.history_last = None
        self.history_worker = None
        self.history_future = None
        self.history_seeking = False

    def send(self, message):
        self.outgoing += control(message)

    def observed(self):
        try:
            self.hooks.on_input()
        except (OSError, ValueError):
            pass  # Activity observation must never interrupt a coding session.

    def update_history(self):
        if self.history_future is not None:
            if not self.history_future.done():
                return
            try:
                state = self.history_future.result()
                if self.history_seeking:
                    self.observed()
            except (OSError, ValueError):
                state = {'available': False, 'lines': 0, 'offset': 0, 'rows': 1, 'active': False}
            self.history_future = None
            if state != self.history_last:
                self.history_last = state
                self.send({'type': 'scrollback', **state})
        if not self.history_subscribed or not self.history_dirty or len(self.outgoing) >= HIGH_WATER:
            return
        now = time.monotonic()
        # Coalesce drag requests; read metadata only after terminal activity.
        # Idle and native connections do not keep spawning tmux queries.
        if now - self.history_checked < (0.1 if self.history_offset is not None else 0.5):
            return
        offset, self.history_offset = self.history_offset, None
        self.history_dirty = False
        self.history_checked = now
        self.history_seeking = offset is not None
        if self.history_worker is None:
            self.history_worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix='outpost-history')
        # Slow tmux commands must not stall PTY traffic or browser keystrokes.
        self.history_future = self.history_worker.submit(self.hooks.scrollback, offset)

    def handle(self, kind, payload, master):
        if kind == b'I':
            self.history_dirty = True
            self.observer.feed(payload)
            self.incoming += payload
            return
        if kind != b'C':
            raise ValueError('Unknown relay frame')
        message = json.loads(payload)
        if message.get('type') == 'scrollback' and hasattr(self.hooks, 'scrollback'):
            offset = message.get('offset')
            if offset is None or (type(offset) is int and -1 <= offset <= 1000000):
                self.history_subscribed = self.history_dirty = True
                if offset is not None:
                    self.history_offset = offset
        elif message.get('type') == 'resize':
            self.history_dirty = True
            cols, rows = message.get('cols'), message.get('rows')
            if isinstance(cols, int) and isinstance(rows, int) and 0 < cols <= 1000 and 0 < rows <= 1000:
                fcntl.ioctl(master, termios.TIOCSWINSZ, winsize(cols, rows))
        elif message.get('type') == 'paste-image':
            reply = {'type': 'paste-result', 'id': message.get('id')}
            try:
                reply.update(self.hooks.paste_image(message.get('extension'), message.get('data')), ok=True)
                self.observed()
            except (OSError, ValueError) as error:
                reply.update(ok=False, message=str(error))
            self.send(reply)
        elif message.get('type') == 'signal-result' and self.signals:
            self.signals.answer(message.get('id'), {'ok': message.get('ok') is True, 'message': message.get('message')})

    def run(self):
        pid, master = pty.fork()
        if pid == 0:
            fcntl.ioctl(0, termios.TIOCSWINSZ, self.size)
            os.execvpe(self.command[0], self.command, self.environment)
        self.observer = InputObserver(self.observed)
        self.signals = None
        if self.signal_path:
            try:
                self.signals = SignalServer(self.signal_path)
            except OSError:
                pass  # Links are optional; attaching must still work.
        decoder = FrameDecoder()
        handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGPIPE)}
        flags = {descriptor: fcntl.fcntl(descriptor, fcntl.F_GETFL) for descriptor in (0, 1)}
        status, reaped, eof = None, False, False

        def stop(_sig, _frame):
            self.stopped = True

        try:
            os.write(1, MAGIC)
            for descriptor in (0, 1, master):
                fcntl.fcntl(descriptor, fcntl.F_SETFL, fcntl.fcntl(descriptor, fcntl.F_GETFL) | os.O_NONBLOCK)
            signal.signal(signal.SIGHUP, stop)
            signal.signal(signal.SIGTERM, stop)
            signal.signal(signal.SIGPIPE, signal.SIG_IGN)
            self.send({'type': 'ready', 'scrollback': hasattr(self.hooks, 'scrollback')})
            while not self.stopped and (not eof or self.outgoing):
                self.observer.flush()
                if not eof:
                    self.update_history()
                if self.signals:
                    self.signals.expire()
                readers = [] if eof or len(self.outgoing) >= HIGH_WATER else [master]
                if len(self.incoming) < HIGH_WATER:
                    readers.append(0)
                if self.signals:
                    readers += [self.signals.socket.fileno(), *self.signals.clients]
                writers = ([master] if self.incoming and not eof else []) + ([1] if self.outgoing else [])
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
                    except OSError as error:
                        if descriptor != master or error.errno != errno.EIO:
                            raise
                        data = b''
                    if not data:
                        if descriptor == 0:
                            self.stopped = True
                        else:
                            eof = True
                        continue
                    if descriptor == 0:
                        for kind, payload in decoder.feed(data):
                            self.handle(kind, payload, master)
                    else:
                        self.history_dirty = True
                        self.outgoing += encode(b'O', data)
                        self.tail = (self.tail + data)[-512:]
                for descriptor in writable:
                    buffer = self.incoming if descriptor == master else self.outgoing
                    try:
                        del buffer[: os.write(descriptor, buffer)]
                    except BlockingIOError:
                        pass
                    except OSError as error:
                        if descriptor == 1:
                            self.stopped = True  # The broker went away.
                        elif error.errno == errno.EIO:
                            eof = True
                            self.incoming.clear()
                        else:
                            raise
            child, status = os.waitpid(pid, os.WNOHANG)
            reaped = child == pid
        finally:
            if self.history_worker:
                self.history_worker.shutdown(wait=False, cancel_futures=True)
            os.close(master)
            if self.signals:
                self.signals.close()
            for sig, handler in handlers.items():
                signal.signal(sig, handler)
            if not reaped:
                # Still our unreaped child, so this PID cannot have been reused.
                try:
                    os.kill(pid, signal.SIGHUP)
                except ProcessLookupError:
                    pass
                _, status = os.waitpid(pid, 0)
        if self.stopped:
            return 0  # The broker closed the connection; tmux keeps the session.
        # tmux prints why its client ended; only a real detach leaves the session running.
        reason = 'detached' if b'[detached' in self.tail else 'ended'
        try:
            for descriptor, value in flags.items():
                fcntl.fcntl(descriptor, fcntl.F_SETFL, value)
            os.write(1, control({'type': 'exit', 'reason': reason}))
        except OSError:
            pass
        return os.waitstatus_to_exitcode(status)
