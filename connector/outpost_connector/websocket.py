"""A small RFC 6455 client: blocking handshake, then non-blocking frames for a select loop."""

import base64
import hashlib
import os
import socket
import ssl
import struct
from urllib.parse import urlsplit

GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
TEXT, BINARY, CLOSE, PING, PONG = 0x1, 0x2, 0x8, 0x9, 0xA
MAX_MESSAGE = 32 * 1024 * 1024


class WebSocketError(OSError):
    pass


class WebSocket:
    def __init__(self, sock, buffered=b''):
        self.sock = sock
        self.incoming = bytearray(buffered)
        self.outgoing = bytearray()
        self.fragments = None
        self.closed = False

    @classmethod
    def connect(cls, url, context=None, timeout=15, user_agent='outpost-connector'):
        parts = urlsplit(url)
        secure = parts.scheme == 'wss'
        port = parts.port or (443 if secure else 80)
        sock = socket.create_connection((parts.hostname, port), timeout=timeout)
        try:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            if secure:
                sock = (context or ssl.create_default_context()).wrap_socket(sock, server_hostname=parts.hostname)
            key = base64.b64encode(os.urandom(16)).decode()
            host = parts.hostname if parts.port is None else parts.hostname + ':' + str(parts.port)
            if ':' in parts.hostname:
                host = '[' + parts.hostname + ']' + ('' if parts.port is None else ':' + str(parts.port))
            request = (
                'GET ' + (parts.path or '/') + ('?' + parts.query if parts.query else '') + ' HTTP/1.1\r\n'
                'Host: ' + host + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n'
                'User-Agent: ' + user_agent + '\r\n\r\n'
            )
            sock.sendall(request.encode())
            response = b''
            while b'\r\n\r\n' not in response:
                chunk = sock.recv(4096)
                if not chunk:
                    raise WebSocketError('The Outpost server closed the connection.')
                response += chunk
                if len(response) > 65536:
                    raise WebSocketError('Invalid response from the Outpost server.')
            head, rest = response.split(b'\r\n\r\n', 1)
            lines = head.decode('latin-1').split('\r\n')
            status = lines[0].split(' ')
            headers = {
                name.strip().lower(): value.strip() for name, _, value in (line.partition(':') for line in lines[1:])
            }
            if len(status) < 2 or status[1] != '101':
                raise WebSocketError('The Outpost server refused the terminal (' + ' '.join(status[1:]) + ').')
            accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
            if headers.get('sec-websocket-accept') != accept:
                raise WebSocketError('Invalid WebSocket handshake from the Outpost server.')
            sock.setblocking(False)
            return cls(sock, rest)
        except BaseException:
            sock.close()
            raise

    def fileno(self):
        return self.sock.fileno()

    def frame(self, opcode, payload):
        header = bytes([0x80 | opcode])
        length = len(payload)
        if length < 126:
            header += bytes([0x80 | length])
        elif length < 65536:
            header += bytes([0x80 | 126]) + struct.pack('>H', length)
        else:
            header += bytes([0x80 | 127]) + struct.pack('>Q', length)
        mask = os.urandom(4)
        masked = (
            bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
            if length < 4096
            else (int.from_bytes(payload, 'big') ^ int.from_bytes((mask * (length // 4 + 1))[:length], 'big')).to_bytes(
                length, 'big'
            )
        )
        self.outgoing += header + mask + masked

    def send_text(self, text):
        self.frame(TEXT, text.encode())

    def send_binary(self, data):
        self.frame(BINARY, bytes(data))

    def close(self, code=1000):
        if not self.closed:
            self.frame(CLOSE, struct.pack('>H', code))
            self.closed = True

    @property
    def wants_write(self):
        return bool(self.outgoing)

    def flush(self):
        while self.outgoing:
            try:
                sent = self.sock.send(self.outgoing)
            except (BlockingIOError, ssl.SSLWantWriteError, ssl.SSLWantReadError):
                return
            if not sent:
                raise WebSocketError('The connection to Outpost was lost.')
            del self.outgoing[:sent]

    def read(self):
        """Read what is available; return complete (opcode, payload) messages. Raises on EOF."""
        while True:
            try:
                chunk = self.sock.recv(65536)
            except (BlockingIOError, ssl.SSLWantReadError, ssl.SSLWantWriteError):
                break
            if not chunk:
                raise WebSocketError('The connection to Outpost was lost.')
            self.incoming += chunk
            if not (isinstance(self.sock, ssl.SSLSocket) and self.sock.pending()):
                break
        messages = []
        while True:
            message = self.parse()
            if message is None:
                return messages
            opcode, payload = message
            if opcode == PING:
                self.frame(PONG, payload)
            elif opcode == CLOSE:
                self.close()
                messages.append((CLOSE, payload))
                return messages
            elif opcode in (TEXT, BINARY):
                messages.append(message)

    def parse(self):
        while True:
            data = self.incoming
            if len(data) < 2:
                return None
            fin, opcode, length = data[0] & 0x80, data[0] & 0x0F, data[1] & 0x7F
            offset = 2
            if length == 126:
                if len(data) < 4:
                    return None
                length, offset = struct.unpack('>H', data[2:4])[0], 4
            elif length == 127:
                if len(data) < 10:
                    return None
                length, offset = struct.unpack('>Q', data[2:10])[0], 10
            if data[1] & 0x80:
                raise WebSocketError('The Outpost server sent a masked frame.')
            if length > MAX_MESSAGE:
                raise WebSocketError('The Outpost server sent an oversized message.')
            if len(data) < offset + length:
                return None
            payload = bytes(data[offset : offset + length])
            del data[: offset + length]
            if opcode >= 0x8:
                return opcode, payload
            if opcode != 0:
                self.fragments = (opcode, bytearray(payload))
            elif self.fragments is None:
                raise WebSocketError('Unexpected continuation frame.')
            else:
                self.fragments[1].extend(payload)
            if fin:
                opcode, payload = self.fragments
                self.fragments = None
                return opcode, bytes(payload)

    def shutdown(self):
        try:
            self.sock.close()
        except OSError:
            pass
