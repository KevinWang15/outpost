"""Short-lived JSON-RPC over a local Unix WebSocket, using only the stdlib.

RFC 6455 without extensions: bounded handshake/messages, client masking,
fragmented text, ping/pong, and one deadline for the whole observation.
No TCP listener, subprocess, or persistent connection is created.
"""

import base64
import hashlib
import json
import os
import socket
import struct
import time

from outpost_rpc import JsonRpcConnection

MAX_MESSAGE = 1024 * 1024
MAX_HEADERS = 8192


class JsonRpcSocket(JsonRpcConnection):
    def __init__(self, path, timeout=2):
        self.deadline = time.monotonic() + timeout
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.buffer = bytearray()
        self.received = 0
        self.upgraded = False
        try:
            self.set_timeout()
            self.socket.connect(str(path))
            # The daemon's rendezvous path may be a symlink into its protected
            # socket directory. Authenticate the peer, not that alias's parent.
            _, uid, _ = struct.unpack('3i', self.socket.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid != os.geteuid():
                raise ValueError('Coding CLI socket belongs to a different user')
            self.handshake()
            self.upgraded = True
        except BaseException:
            self.close()
            raise

    def set_timeout(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise ValueError('Coding CLI status request timed out')
        self.socket.settimeout(remaining)

    def write(self, data):
        self.set_timeout()
        self.socket.sendall(data)

    def read(self, size):
        while len(self.buffer) < size:
            self.set_timeout()
            chunk = self.socket.recv(65536)
            if not chunk:
                raise ValueError('Coding CLI status connection closed')
            self.received += len(chunk)
            if self.received > 4 * MAX_MESSAGE:
                raise ValueError('Coding CLI status response exceeded its size limit')
            self.buffer.extend(chunk)
        result = bytes(self.buffer[:size])
        del self.buffer[:size]
        return result

    def handshake(self):
        key = base64.b64encode(os.urandom(16))
        self.write(
            b'GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
            b'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ' + key + b'\r\n\r\n'
        )
        header = bytearray()
        while not header.endswith(b'\r\n\r\n'):
            if len(header) >= MAX_HEADERS:
                raise ValueError('Coding CLI WebSocket headers exceeded their size limit')
            header.extend(self.read(1))
        lines = bytes(header).split(b'\r\n')
        fields = {}
        for line in lines[1:-2]:
            name, separator, value = line.partition(b':')
            name = name.lower()
            if not separator or name in fields:
                raise ValueError('Invalid coding CLI WebSocket headers')
            fields[name] = value.strip()
        accept = base64.b64encode(hashlib.sha1(key + b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest())
        if (
            lines[0].split(b' ')[:2] != [b'HTTP/1.1', b'101']
            or fields.get(b'upgrade', b'').lower() != b'websocket'
            or b'upgrade' not in [value.strip().lower() for value in fields.get(b'connection', b'').split(b',')]
            or fields.get(b'sec-websocket-accept') != accept
            or b'sec-websocket-extensions' in fields
            or b'sec-websocket-protocol' in fields
        ):
            raise ValueError('Coding CLI rejected the WebSocket handshake')

    def frame(self, opcode, payload):
        size = len(payload)
        if size > MAX_MESSAGE:
            raise ValueError('Coding CLI protocol message exceeded its size limit')
        prefix = bytes([0x80 | opcode])
        if size < 126:
            prefix += bytes([0x80 | size])
        elif size <= 65535:
            prefix += b'\xfe' + struct.pack('!H', size)
        else:
            prefix += b'\xff' + struct.pack('!Q', size)
        mask = os.urandom(4)
        self.write(prefix + mask + bytes(value ^ mask[index % 4] for index, value in enumerate(payload)))

    def send(self, message):
        self.frame(1, json.dumps(message, separators=(',', ':')).encode())

    def receive(self):
        content = bytearray()
        started = False
        while True:
            self.set_timeout()
            first, second = self.read(2)
            final, opcode, size = bool(first & 0x80), first & 0x0F, second & 0x7F
            if first & 0x70 or second & 0x80:
                raise ValueError('Invalid coding CLI WebSocket frame')
            if opcode >= 8 and (not final or size > 125):
                raise ValueError('Invalid coding CLI WebSocket control frame')
            if size == 126:
                size = struct.unpack('!H', self.read(2))[0]
            elif size == 127:
                size = struct.unpack('!Q', self.read(8))[0]
            if size > MAX_MESSAGE or (opcode < 8 and len(content) + size > MAX_MESSAGE):
                raise ValueError('Coding CLI protocol message exceeded its size limit')
            payload = self.read(size)
            if opcode == 8:
                raise ValueError('Coding CLI status connection closed')
            if opcode == 9:
                self.frame(10, payload)
                continue
            if opcode == 10:
                continue
            if opcode != (0 if started else 1):
                raise ValueError('Invalid coding CLI WebSocket text frame')
            started = True
            content.extend(payload)
            if final:
                try:
                    return json.loads(content.decode('utf-8'))
                except (ValueError, UnicodeError, RecursionError) as error:
                    raise ValueError('Coding CLI returned invalid JSON') from error

    def close(self):
        if self.upgraded:
            try:
                self.frame(8, struct.pack('!H', 1000))
            except (OSError, ValueError):
                pass
        self.socket.close()
