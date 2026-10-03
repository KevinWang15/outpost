"""Ephemeral, byte-preserving attachment relay; persistence still belongs to tmux/dtach."""
import errno
import fcntl
import os
import pty
import re
import select
import signal
import struct
import termios
import time
import tty


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
                    data = data[len(sequence):]
                    continue
                if len(data) < 256:
                    self.pending, self.deadline = data, time.monotonic() + 0.1
                    return
            elif data.startswith(b'\x1b]'):
                match = re.match(rb'\x1b\].*?(?:\x07|\x1b\\)', data, re.DOTALL)
                if match:
                    data = data[len(match.group()):]
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


def attach(command, environment, on_input, repaint=False):
    size = fcntl.ioctl(0, termios.TIOCGWINSZ, bytes(8))
    pid, master = pty.fork()
    if pid == 0:
        fcntl.ioctl(0, termios.TIOCSWINSZ, size)
        os.execvpe(command[0], command, environment)
    original = termios.tcgetattr(0)
    flags = {descriptor: fcntl.fcntl(descriptor, fcntl.F_GETFL) for descriptor in (0, 1)}
    handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGWINCH, signal.SIGHUP, signal.SIGTERM)}
    stopped = False
    resized = False
    status = None
    reaped = False

    def stop(_sig, _frame):
        nonlocal stopped
        stopped = True

    def resize(_sig, _frame):
        nonlocal resized
        resized = True

    def checked():
        try:
            on_input()
        except (OSError, ValueError):
            # Activity observation must never interrupt a coding session.
            pass

    observer = InputObserver(checked)
    incoming, outgoing = bytearray(), bytearray()
    eof = False
    redraw_at = time.monotonic() + 0.15 if repaint else None
    restore_at = None
    temporary = None
    try:
        tty.setraw(0)
        # All three supported CLIs understand focus reports. Request them on
        # each attachment because dtach does not replay startup terminal modes.
        os.write(1, b'\x1b[?1004h')
        for descriptor in (0, 1, master):
            fcntl.fcntl(descriptor, fcntl.F_SETFL, fcntl.fcntl(descriptor, fcntl.F_GETFL) | os.O_NONBLOCK)
        signal.signal(signal.SIGWINCH, resize)
        signal.signal(signal.SIGHUP, stop)
        signal.signal(signal.SIGTERM, stop)
        while not stopped and (not eof or outgoing):
            if resized:
                size = fcntl.ioctl(0, termios.TIOCGWINSZ, bytes(8))
                fcntl.ioctl(master, termios.TIOCSWINSZ, size)
                temporary, restore_at, resized = None, None, False
            clock = time.monotonic()
            if redraw_at is not None and clock >= redraw_at and not termios.tcgetattr(master)[3] & termios.ICANON:
                rows, columns, xp, yp = struct.unpack('HHHH', size)
                if rows and columns:
                    temporary = struct.pack('HHHH', rows, columns - 1 if columns > 1 else 2, xp, yp)
                    fcntl.ioctl(master, termios.TIOCSWINSZ, temporary)
                    restore_at = clock + 0.25
                redraw_at = None
            if restore_at is not None and clock >= restore_at:
                if fcntl.ioctl(master, termios.TIOCGWINSZ, bytes(8)) == temporary:
                    fcntl.ioctl(master, termios.TIOCSWINSZ, size)
                restore_at = None
            observer.flush()
            readers = ([] if eof or len(outgoing) >= 256 * 1024 else [master])
            if not eof and len(incoming) < 256 * 1024:
                readers.append(0)
            writable = ([master] if incoming and not eof else []) + ([1] if outgoing else [])
            ready, writers, _ = select.select(readers, writable, [], 0.05)
            for descriptor in ready:
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
                        stopped = True
                    else:
                        eof = True
                    continue
                if descriptor == 0:
                    observer.feed(data)
                    incoming.extend(data)
                else:
                    outgoing.extend(data)
            for descriptor in writers:
                buffer = incoming if descriptor == master else outgoing
                try:
                    del buffer[:os.write(descriptor, buffer)]
                except BlockingIOError:
                    pass
                except OSError as error:
                    if descriptor != master or error.errno != errno.EIO:
                        raise
                    eof = True
                    incoming.clear()
        child, status = os.waitpid(pid, os.WNOHANG)
        reaped = child == pid
    finally:
        os.close(master)
        for descriptor, value in flags.items():
            fcntl.fcntl(descriptor, fcntl.F_SETFL, value)
        try:
            os.write(1, b'\x1b[?1004l')
            termios.tcsetattr(0, termios.TCSADRAIN, original)
        except (OSError, termios.error):
            pass  # The outer SSH terminal may already have disappeared.
        for sig, handler in handlers.items():
            signal.signal(sig, handler)
        if not reaped:
            # This PID is still our unreaped child, so it cannot be reused.
            if stopped:
                try:
                    os.kill(pid, signal.SIGHUP)
                except ProcessLookupError:
                    pass
            _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status)
