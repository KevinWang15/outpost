"""Bounded JSON-RPC over a short-lived coding CLI process."""
import json
import os
import selectors
import signal
import subprocess
import time


class JsonRpcProcess:
    """A bounded, short-lived local CLI protocol connection; no target-side manager agent."""
    def __init__(self, command, environment, cwd):
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, env=environment, cwd=cwd, bufsize=0,
                                        start_new_session=True)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.buffer = b''
        self.sequence = 0
        self.deadline = time.monotonic() + 18

    def __enter__(self):
        return self

    def __exit__(self, *exception):
        self.close()

    def send(self, message):
        try:
            self.process.stdin.write((json.dumps(message) + '\n').encode())
        except (BrokenPipeError, OSError) as error:
            raise ValueError('Coding CLI exited during session initialization. Check its configuration and login.') from error

    def call(self, method, params):
        self.sequence += 1
        self.send({'jsonrpc': '2.0', 'id': self.sequence, 'method': method, 'params': params})
        while time.monotonic() < self.deadline:
            if b'\n' not in self.buffer:
                if not self.selector.select(min(1, max(0, self.deadline - time.monotonic()))):
                    continue
                chunk = os.read(self.process.stdout.fileno(), 65536)
                if not chunk:
                    raise ValueError('Coding CLI exited during session initialization. Check its configuration and login.')
                self.buffer += chunk
                if len(self.buffer) > 1024 * 1024:
                    raise ValueError('Coding CLI protocol response exceeded the size limit')
            while b'\n' in self.buffer:
                line, self.buffer = self.buffer.split(b'\n', 1)
                try:
                    message = json.loads(line)
                except (ValueError, UnicodeError, RecursionError) as error:
                    raise ValueError('Coding CLI returned an invalid protocol response') from error
                if not isinstance(message, dict):
                    raise ValueError('Coding CLI returned an invalid protocol response')
                if message.get('id') == self.sequence and ('result' in message or 'error' in message):
                    if 'error' in message:
                        error = message['error']
                        if not isinstance(error, dict) or not isinstance(error.get('message'), str):
                            raise ValueError('Coding CLI returned an invalid protocol error')
                        raise ValueError('Coding CLI initialization failed: ' + error['message'][:280])
                    if not isinstance(message['result'], dict):
                        raise ValueError('Coding CLI returned an invalid protocol result')
                    return message['result']
                if 'id' in message and 'method' in message:
                    self.send({'jsonrpc': '2.0', 'id': message['id'], 'error': {'code': -32601, 'message': 'No interactive client during initialization'}})
        raise ValueError('Coding CLI session initialization timed out. Check its configuration and login.')

    def close(self):
        self.selector.close()
        self.process.stdin.close()
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.process.wait()
