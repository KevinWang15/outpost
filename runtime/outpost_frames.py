"""Shared framing for terminal service RPC and streaming relay connections."""

import json
import struct

MAGIC = b'\x00OUTPOST-RELAY-2\x00'
HEADER = struct.Struct('>cI')
MAX_FRAME = 32 * 1024 * 1024


def header(data, limit=MAX_FRAME):
    kind, length = HEADER.unpack(data)
    if kind not in (b'I', b'O', b'C') or length > limit:
        raise ValueError('Invalid terminal frame')
    return kind, length


def encode(kind, payload):
    if kind not in (b'I', b'O', b'C') or len(payload) > MAX_FRAME:
        raise ValueError('Invalid terminal frame')
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
            kind, length = header(self.buffer[: HEADER.size])
            end = HEADER.size + length
            if len(self.buffer) < end:
                break
            frames.append((kind, bytes(self.buffer[HEADER.size : end])))
            del self.buffer[:end]
        return frames
