"""Stands in for the target relay behind the broker, speaking the relay protocol.

FAKE_RELAY=fail   prints a runtime error before the relay starts.
Otherwise it prints login noise, then echoes input, reports resizes, answers
paste-image requests and sends a signal when it receives the text 'signal:<url>'.
"""

import json
import os
import struct
import sys

out = sys.stdout.buffer


def frame(kind, payload):
    out.write(kind + struct.pack('>I', len(payload)) + payload)
    out.flush()


def control(message):
    frame(b'C', json.dumps(message).encode())


out.write(b'Welcome to the target!\n')
if os.environ.get('FAKE_RELAY') == 'fail':
    out.write(
        b'OUTPOST_RESULT:'
        + json.dumps({'ok': False, 'error': {'message': 'Session not found', 'status': 404}}).encode()
        + b'\n'
    )
    out.flush()
    sys.exit(1)
out.write(b'\x00OUTPOST-RELAY-2\x00')
control({'type': 'ready'})
frame(b'O', ('started ' + ' '.join(sys.argv[1:])).encode())
buffer = b''
stdin = sys.stdin.buffer
while True:
    chunk = os.read(stdin.fileno(), 65536)
    if not chunk:
        break
    buffer += chunk
    while len(buffer) >= 5:
        kind, length = struct.unpack('>cI', buffer[:5])
        if len(buffer) < 5 + length:
            break
        payload, buffer = buffer[5 : 5 + length], buffer[5 + length :]
        if kind == b'I':
            if payload.startswith(b'signal:'):
                control(
                    {
                        'type': 'signal',
                        'id': 's1',
                        'signal': {'type': 'browser.open', 'payload': {'url': payload[7:].decode()}},
                    }
                )
            elif payload == b'detach':
                control({'type': 'exit', 'reason': 'detached'})
                sys.exit(0)
            else:
                frame(b'O', b'echo:' + payload)
        else:
            message = json.loads(payload)
            if message['type'] == 'resize':
                frame(b'O', ('size:%dx%d' % (message['cols'], message['rows'])).encode())
            elif message['type'] == 'send':
                frame(b'O', b'echo:' + message['data'].encode())
                control({'type': 'result', 'id': message['id'], 'ok': True})
            elif message['type'] == 'paste-image':
                control(
                    {
                        'type': 'paste-result',
                        'id': message['id'],
                        'ok': True,
                        'reference': '/root/.outpost/clipboard/x.' + message['extension'],
                    }
                )
            elif message['type'] == 'signal-result':
                frame(b'O', ('signal-result:' + json.dumps(message['ok'])).encode())
