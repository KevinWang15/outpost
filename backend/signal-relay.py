"""Loopback HTTP to framed stdio. SSH/local/WSL transports own this process.

The relay knows no signal types or user identities. Only Outpost resolves tokens
and decides whether a listener exists. EOF removes the receiver immediately.
"""
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import queue
import shlex
import sys
import threading
import uuid

MAX_BODY = 32 * 1024
PREFIX = 'OUTPOST_SIGNAL:'


def main():
    settings = json.loads(base64.b64decode(sys.argv[1]))
    context = settings.get('context') or {}
    if context and context['uid'] != os.getuid():
        raise ValueError('Target user changed. Refresh Required Software.')
    root = Path(context.get('home') or Path.home()) / '.outpost' / 'signals' / settings['scope']
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    outgoing = threading.Lock()
    pending = {}
    slots = threading.BoundedSemaphore(16)

    def emit(value):
        with outgoing:
            print(PREFIX + json.dumps(value, allow_nan=False), flush=True)

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(15)

        def log_message(self, *_args):
            pass  # URLs, payloads and bearer tokens never enter logs.

        def respond(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            if self.path != '/signals' or self.headers.get('Origin'):
                return self.respond(403, {'message': 'Use the target signal endpoint.'})
            if not self.headers.get('Authorization', '').startswith('Bearer '):
                return self.respond(401, {'message': 'An Outpost session token is required.'})
            try:
                length = int(self.headers.get('Content-Length', '0'))
            except ValueError:
                length = 0
            if not 0 < length <= MAX_BODY or self.headers.get('Transfer-Encoding'):
                return self.respond(413, {'message': 'Signals must fit within 32 KiB.'})
            if not slots.acquire(blocking=False):
                return self.respond(429, {'message': 'Too many pending signals.'})
            identity = str(uuid.uuid4())
            answer = queue.Queue(maxsize=1)
            try:
                body = json.loads(self.rfile.read(length))
                pending[identity] = answer
                emit({'kind': 'signal', 'id': identity, 'token': self.headers['Authorization'][7:], 'body': body})
                try:
                    response = answer.get(timeout=12)
                except queue.Empty:
                    response = {'status': 504, 'body': {'message': 'Outpost did not respond in time.'}}
                self.respond(response['status'], response['body'])
            except (ValueError, RecursionError):
                self.respond(400, {'message': 'Invalid signal JSON.'})
            except OSError:
                pass
            finally:
                pending.pop(identity, None)
                slots.release()

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    url = 'http://127.0.0.1:' + str(server.server_port) + '/signals'
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    emit({'kind': 'ready'})

    def write(path, text, mode):
        temporary = path.with_name(path.name + '.' + uuid.uuid4().hex)
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        try:
            with os.fdopen(descriptor, 'w') as stream:
                stream.write(text)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)

    try:
        for line in sys.stdin:
            if len(line) > 128 * 1024:
                break
            command = json.loads(line)
            if command['kind'] == 'response':
                answer = pending.get(command['id'])
                if answer and answer.empty():
                    answer.put_nowait(command)
            elif command['kind'] == 'configure':
                session = root / hashlib.sha256(command['sessionId'].encode()).hexdigest()[:32]
                binary = session / 'bin'
                binary.mkdir(mode=0o700, parents=True, exist_ok=True)
                config = session / 'connection.json'
                write(config, json.dumps({'url': url, 'token': command['token']}), 0o600)
                for name in ('outpost-browser', 'outpost-signal'):
                    write(binary / name, settings['client'], 0o700)
                environment = {
                    'BROWSER': 'outpost-browser', 'OUTPOST_SIGNAL_BIN': str(binary),
                    'OUTPOST_SIGNAL_CONFIG': str(config), 'OUTPOST_SIGNAL_URL': url,
                    'OUTPOST_SIGNAL_ENV': str(session / 'environment.sh'),
                    'OUTPOST_SESSION_TOKEN': command['token']}
                exports = ''.join('export ' + key + '=' + shlex.quote(value) + '\n' for key, value in environment.items())
                exports += 'export PATH=' + shlex.quote(str(binary)) + ':"${PATH-}"\n'
                write(session / 'environment.sh', exports, 0o600)
                emit({'kind': 'configured', 'id': command['id'], 'environment': environment})
    finally:
        for answer in list(pending.values()):
            if answer.empty():
                answer.put_nowait({'status': 503, 'body': {'message': 'Outpost disconnected.'}})
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
