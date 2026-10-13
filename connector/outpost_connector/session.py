"""The native terminal client: your terminal ⇄ Outpost terminal protocol.

One select loop owns the TTY and the WebSocket. Clipboard reads and link opens
run in short worker threads; their results come back through a wake pipe. A
paste gesture holds later keystrokes until the clipboard decision is made, so
typing order is preserved.
"""

import base64
import json
import os
import queue
import select
import signal
import termios
import threading
import time
import tty
import uuid
from urllib.parse import urlsplit

from . import VERSION
from .keys import PASTE_KEY, InputRouter, bracketed
from .screen import OutputFilter
from .websocket import BINARY, CLOSE, TEXT, WebSocket, WebSocketError

# Leave alternate screens and input protocols behind after a connection ends.
RESET = (
    '\x1b7\x1b[?1049l\x1b8\x1b[0m\x1b[?25h\x1b[?1l\x1b[?1000l\x1b[?1002l\x1b[?1003l'
    '\x1b[?1004l\x1b[?1006l\x1b[?2004l\x1b[<u\x1b[>4;0m'
)
RETRIES = 8
# How each close reason in shared/protocol.ts ends a connection:
# (banner heading, keys line, Enter reconnects). 'error' retries on its own.
CLOSE_REASONS = {
    'detached': ('Detached from {name}', 'Enter  reconnect      Ctrl+C  close', True),
    'ended': ('{name} ended', 'Enter  reconnect      Ctrl+C  close', True),
    'expired': ('Connection expired', 'Press any key to close', False),
    'outdated': ('Outpost Connector needs an update', 'Press any key to close', False),
    'error': None,
}


class Outcome:
    def __init__(self, reason, message, connected=False):
        self.reason = reason
        self.message = message
        self.connected = connected


class Session:
    def __init__(self, link, platform, input_fd=0, output_fd=1):
        self.link = link
        self.platform = platform
        self.input = input_fd
        self.output = output_fd
        self.token = link.token
        self.resumable = False
        self.name = link.title
        self.title_until = 0.0
        self.events = queue.Queue()
        self.wake_read, self.wake_write = os.pipe()
        self.resized = False

    # Terminal output helpers ------------------------------------------------
    def write(self, data):
        data = data.encode() if isinstance(data, str) else data
        while data:
            try:
                data = data[os.write(self.output, data) :]
            except BlockingIOError:
                select.select([], [self.output], [], 1)

    def title(self, status=None, seconds=4):
        text = 'Outpost · ' + self.name + (' — ' + status if status else '')
        self.write('\x1b]2;' + ''.join(c for c in text if c.isprintable()) + '\x07')
        self.title_until = time.monotonic() + seconds if status else 0.0

    def size(self):
        try:
            columns, lines = os.get_terminal_size(self.output)
        except OSError:
            columns, lines = 80, 24
        return max(2, min(1000, columns)), max(2, min(1000, lines))

    def wake(self, *_args):
        try:
            os.write(self.wake_write, b'.')
        except OSError:
            pass

    def background(self, work, *args):
        def run():
            try:
                self.events.put((work.__name__, args, work(*args), None))
            except Exception as error:  # Reported back to the loop, never raised in a thread.
                self.events.put((work.__name__, args, None, error))
            self.wake()

        threading.Thread(target=run, daemon=True).start()

    # Lifecycle ----------------------------------------------------------------
    def run(self):
        if not os.isatty(self.input):
            raise OSError('Run outpost-connector attach inside a terminal window.')
        saved = termios.tcgetattr(self.input)
        previous = signal.signal(signal.SIGWINCH, self.on_resize)
        tty.setraw(self.input)
        try:
            self.title()
            failures = 0
            while True:
                self.write('\r\n\x1b[2mOutpost · connecting to ' + self.name + '…\x1b[0m\r\n')
                outcome = self.connect()
                self.write(RESET)
                if outcome.connected:
                    failures = 0
                if outcome.reason == 'quit':
                    return 0
                final = CLOSE_REASONS.get(outcome.reason)
                if final:
                    heading, keys, resumable = final
                    self.banner(heading.format(name=self.name), outcome.message, keys)
                    key = self.read_key()
                    if not resumable:
                        return 1
                    if key != 'enter':
                        return 0
                    continue
                failures += 1
                if failures > RETRIES:
                    self.banner('Could not reconnect', outcome.message, 'Enter  try again      Ctrl+C  close')
                    if self.read_key() != 'enter':
                        return 0
                    failures = 0
                    continue
                delay = min(10, 2 ** (failures - 1))
                self.banner(
                    'Connection lost',
                    outcome.message,
                    'Reconnecting in ' + str(delay) + 's   Enter  now      Ctrl+C  close',
                )
                if self.read_key(delay) == 'quit':
                    return 0
        finally:
            termios.tcsetattr(self.input, termios.TCSADRAIN, saved)
            signal.signal(signal.SIGWINCH, previous)
            self.write(RESET + '\r\n')

    def on_resize(self, *_args):
        self.resized = True
        self.wake()

    def banner(self, heading, message, keys):
        lines = [heading, *[line for line in (message or '').split('\n') if line], '', keys]
        width = min(max(len(line) for line in lines) + 4, max(20, self.size()[0] - 2))
        body = ['│ ' + line[: width - 4].ljust(width - 4) + ' │' for line in lines]
        self.write('\r\n'.join(['', '╭' + '─' * (width - 2) + '╮', *body, '╰' + '─' * (width - 2) + '╯', '']) + '\r\n')

    def read_key(self, timeout=None):
        """'enter', 'quit' or None (timed out). Escape sequences and other keys are ignored."""
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            remaining = None if deadline is None else max(0, deadline - time.monotonic())
            if remaining == 0:
                return None
            ready = select.select([self.input, self.wake_read], [], [], remaining)[0]
            if self.wake_read in ready:
                os.read(self.wake_read, 4096)
            if self.input in ready:
                data = os.read(self.input, 1024)
                if not data or any(byte in data for byte in (b'\x03', b'\x04', b'q')):
                    return 'quit'
                if b'\r' in data or b'\n' in data:
                    return 'enter'

    # One connection -------------------------------------------------------------
    def connect(self):
        cols, rows = self.size()
        try:
            socket = WebSocket.connect(
                self.link.websocket_url(self.token, cols, rows),
                self.platform.ssl_context(),
                user_agent='outpost-connector/' + VERSION,
            )
        except (OSError, WebSocketError) as error:
            return Outcome('error', 'Could not reach ' + urlsplit(self.link.server).netloc + ': ' + str(error))
        try:
            return Connection(self, socket).loop()
        finally:
            socket.shutdown()


class Connection:
    def __init__(self, session, socket):
        self.session = session
        self.socket = socket
        self.router = InputRouter()
        self.screen = OutputFilter(self.copy)
        self.held = []  # Keystrokes waiting for a clipboard decision.
        self.blocked = False
        self.connected = False
        self.outcome = None
        self.quiet_since = time.monotonic()

    def copy(self, text):
        self.session.background(self.session.platform.write_clipboard, text)

    def send(self, message):
        self.socket.send_text(json.dumps(message))

    def keystrokes(self, data):
        if self.blocked:
            self.held.append(data)
            return
        actions = self.router.feed(data)
        for index, action in enumerate(actions):
            if action[0] == 'data':
                self.socket.send_binary(action[1])
                continue
            _, kind, original = action
            self.blocked = True
            # Everything after the gesture waits, in order, and is parsed again later.
            rest = b''.join(item[1] if item[0] == 'data' else (item[2] or PASTE_KEY) for item in actions[index + 1 :])
            self.held.append(rest + self.router.pending)
            self.router.reset()
            self.session.background(self.clipboard, kind, original)
            return

    def clipboard(self, kind, original):
        return self.session.platform.read_clipboard(images_only=kind == 'image')

    def pasted(self, kind, original, result, error):
        if error is not None:
            if original:
                self.socket.send_binary(original)
            self.session.title('Clipboard unavailable: ' + str(error)[:80])
        elif result.kind == 'image':
            self.send(
                {
                    'type': 'paste-image',
                    'id': uuid.uuid4().hex,
                    'mediaType': 'image/png',
                    'data': base64.b64encode(result.value).decode(),
                }
            )
            self.session.title('Uploading image…', seconds=30)
        elif result.kind == 'text' and kind == 'any':
            self.socket.send_binary(bracketed(result.value, self.screen.bracketed_paste).encode())
        elif original:
            self.socket.send_binary(original)  # Ctrl+V / Alt+V without an image keeps its meaning.
        elif kind == 'any':
            self.session.title('The clipboard is empty')
        self.blocked = False
        held, self.held = b''.join(self.held), []
        if held:
            self.keystrokes(held)

    # Server messages (shared/protocol.ts) ------------------------------------
    def message(self, message):
        handler = HANDLERS.get(message.get('type'))
        if handler:
            handler(self, message)

    def hello(self, message):
        # Reconnects use the resume token; the launch token was single use.
        self.session.token = message['resume']
        self.session.resumable = True
        self.session.name = message['session']['name'] + ' · ' + message['target']['name']
        self.session.title()

    def ready(self, _message):
        self.connected = True

    def result(self, message):
        if message.get('ok'):
            self.session.title('Image pasted' if message.get('reference') else None)
        else:
            self.session.write('\x07')
            self.session.title('Paste failed: ' + str(message.get('message', ''))[:80], seconds=8)

    def signal(self, message):
        signal_message = message.get('signal') or {}
        handler = SIGNALS.get(signal_message.get('type'))
        if handler:
            handler(self, signal_message.get('payload') or {})

    def open_link(self, payload):
        url = payload.get('url')
        if isinstance(url, str) and urlsplit(url).scheme in ('http', 'https'):
            self.session.background(self.session.platform.open_url, url)
            self.session.title('Opened a link in your browser')

    def closed(self, message):
        self.outcome = Outcome(message.get('reason', 'error'), message.get('message', ''), self.connected)

    def loop(self):
        session = self.session
        while True:
            if session.title_until and time.monotonic() > session.title_until:
                session.title()
            waiting = self.router.waiting or self.screen.held or session.title_until
            readers = [session.input, self.socket, session.wake_read]
            writers = [self.socket] if self.socket.wants_write else []
            try:
                ready, writable, _ = select.select(readers, writers, [], 0.04 if waiting else 1)
            except InterruptedError:
                continue
            try:
                if session.wake_read in ready:
                    os.read(session.wake_read, 4096)
                    if session.resized:
                        session.resized = False
                        cols, rows = session.size()
                        self.send({'type': 'resize', 'cols': cols, 'rows': rows})
                    while not session.events.empty():
                        name, args, result, error = session.events.get()
                        if name == 'clipboard':
                            self.pasted(*args, result, error)
                        elif error is not None:
                            session.title(
                                ('Copy failed: ' if name == 'write_clipboard' else 'Could not open the link: ')
                                + str(error)[:60]
                            )
                if session.input in ready:
                    data = os.read(session.input, 65536)
                    if not data:
                        return Outcome('quit', '')
                    self.keystrokes(data)
                if self.socket in ready:
                    for opcode, payload in self.socket.read():
                        if opcode == BINARY:
                            session.write(self.screen.feed(payload))
                            self.send({'type': 'ack', 'bytes': len(payload)})
                            self.quiet_since = time.monotonic()
                        elif opcode == TEXT:
                            self.message(json.loads(payload))
                        elif opcode == CLOSE:
                            self.socket.flush()
                            return self.outcome or Outcome('error', 'Outpost closed the connection.', self.connected)
                if not self.blocked:
                    for action in self.router.flush():
                        self.socket.send_binary(action[1])
                if self.screen.held and time.monotonic() - self.quiet_since > 0.05:
                    session.write(self.screen.flush())
                self.socket.flush()
            except (OSError, WebSocketError, ValueError) as error:
                return self.outcome or Outcome(
                    'error', str(error) or 'The connection to Outpost was lost.', self.connected
                )


# One handler per server message type and per signal type; tests/unit/contracts
# checks these against shared/protocol.ts and shared/signals.ts.
HANDLERS = {
    'hello': Connection.hello,
    'ready': Connection.ready,
    'result': Connection.result,
    'signal': Connection.signal,
    'closed': Connection.closed,
}
SIGNALS = {'browser.open': Connection.open_link}
