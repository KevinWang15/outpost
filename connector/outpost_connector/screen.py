"""Output shims: take OSC 52 copies out of the stream and track terminal modes.

Copies are written to the local clipboard directly, so no terminal permission
prompt is needed. Clipboard *read* requests are dropped (principle 6).
"""

import base64
import binascii
import re

OSC52 = b'\x1b]52;'
MAX_COPY = 1024 * 1024
TERMINATOR = re.compile(rb'\x07|\x1b\\')
MODES = re.compile(rb'\x1b\[\?([0-9;]+)([hl])')


class OutputFilter:
    def __init__(self, on_copy):
        self.on_copy = on_copy
        self.held = b''
        self.bracketed_paste = False

    def feed(self, data):
        data = self.held + data
        self.held = b''
        output = bytearray()
        while data:
            start = data.find(OSC52)
            if start < 0:
                # Hold a tail that could be the start of a split OSC 52.
                for size in range(min(len(OSC52) - 1, len(data)), 0, -1):
                    if OSC52.startswith(data[-size:]):
                        self.held, data = data[-size:], data[:-size]
                        break
                output += data
                break
            output += data[:start]
            end = TERMINATOR.search(data, start + len(OSC52))
            if not end:
                if len(data) - start > MAX_COPY * 2:
                    output += data[start:]  # Not a copy we can handle; pass it through.
                else:
                    self.held = data[start:]
                break
            self.copy(data[start + len(OSC52) : end.start()])
            data = data[end.end() :]
        self.track(bytes(output))
        return bytes(output)

    def flush(self):
        """Release a held prefix (e.g. a trailing Escape) once the stream goes quiet."""
        if self.held and not self.held.startswith(OSC52):
            data, self.held = self.held, b''
            return data
        return b''

    def copy(self, body):
        selection, _, encoded = body.partition(b';')
        if encoded in (b'', b'?') or not re.fullmatch(rb'[cpqs0-7]*', selection):
            return
        try:
            text = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError):
            return
        if len(text) <= MAX_COPY:
            self.on_copy(text.decode('utf-8', 'replace'))

    def track(self, output):
        for match in MODES.finditer(output):
            if b'2004' in match.group(1).split(b';'):
                self.bracketed_paste = match.group(2) == b'h'
