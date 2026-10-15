"""Target runtime and relay against the terminal service, in a disposable home."""

import base64
import json
import os
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / 'runtime'
FIXTURE = ROOT / 'tests' / 'fixtures' / 'coding-tool-fixture.py'
sys.path.insert(0, str(RUNTIME))
from outpost_relay import MAGIC, FrameDecoder, control, encode  # noqa: E402

BINARY = (
    ROOT
    / 'terminal-service'
    / 'dist'
    / ('outpost-terminal-linux-' + ('arm64' if os.uname().machine == 'aarch64' else 'x64') + '-glibc')
)

PNG = base64.b64encode(b'\x89PNG\r\n\x1a\n' + b'0' * 64).decode()


@unittest.skipUnless(BINARY.is_file(), 'npm run build:terminal is required')
class RuntimeTest(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix='outpost-runtime-'))
        self.home = self.directory / "home with 'quotes"
        self.bin = self.home / 'bin'
        self.bin.mkdir(parents=True)
        service = self.home / '.outpost' / 'bin'
        service.mkdir(parents=True)
        shutil.copy(BINARY, service / 'outpost-terminal')
        for tool in ('claude', 'codex', 'kimi'):
            target = self.bin / tool
            shutil.copy(FIXTURE, target)
            target.chmod(0o700)
        self.project = self.home / 'project'
        self.project.mkdir()
        self.env = {
            **os.environ,
            'HOME': str(self.home),
            'PATH': str(self.bin) + ':' + os.environ['PATH'],
            'PYTHONPATH': str(RUNTIME),
        }
        self.env.pop('TMUX', None)

    def tearDown(self):
        for session in self.call({'action': 'list'}).get('sessions', []):
            self.call({'action': 'terminate', 'id': session['id']})
        shutil.rmtree(self.directory, ignore_errors=True)

    def command(self, request):
        payload = base64.b64encode(json.dumps(request).encode()).decode()
        return [sys.executable, str(RUNTIME / 'outpost_runtime.py'), payload]

    def call(self, request, stdin=b'', expect_ok=True):
        result = subprocess.run(self.command(request), input=stdin, capture_output=True, env=self.env, timeout=30)
        line = next(
            line for line in reversed(result.stdout.decode().splitlines()) if line.startswith('OUTPOST_RESULT:')
        )
        envelope = json.loads(line[len('OUTPOST_RESULT:') :])
        if expect_ok:
            self.assertTrue(envelope['ok'], envelope)
            return envelope['data']
        self.assertFalse(envelope['ok'])
        return envelope['error']

    def create(self, name='Build', tool='claude'):
        return self.call(
            {'action': 'create', 'name': name, 'rootDir': str(self.project), 'tool': tool, 'env': {}, 'args': ''}
        )

    def git(self, *arguments, cwd=None):
        return subprocess.run(
            ['git', '-C', str(cwd or self.project), *arguments],
            env=self.env,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()

    def repository(self):
        self.git('init', '-b', 'main')
        (self.project / 'tracked.txt').write_text('committed content')
        self.git('add', 'tracked.txt')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'Initial commit')

    def test_fork_creates_worktree_and_fresh_session_with_inherited_settings(self):
        self.repository()
        (self.project / 'tracked.txt').write_text('uncommitted content')
        for tool in ('claude', 'codex', 'kimi'):
            with self.subTest(tool=tool):
                source = self.call(
                    {
                        'action': 'create',
                        'name': tool,
                        'tool': tool,
                        'rootDir': str(self.project),
                        'env': {'MODEL': 'fixture'},
                        'args': '--model "$MODEL"',
                    }
                )
                branch = 'feature/' + tool
                destination = self.home / (tool + " fork's worktree")
                fork = self.call(
                    {'action': 'fork', 'id': source['id'], 'branch': branch, 'rootDir': '~/' + destination.name}
                )
                self.assertEqual(fork['rootDir'], str(destination))
                self.assertEqual(fork['name'], branch)
                self.assertEqual(fork['tool'], tool)
                self.assertEqual(fork['env'], source['env'])
                self.assertEqual(fork['args'], source['args'])
                self.assertEqual(fork['cliSessionEnv'], source['cliSessionEnv'])
                self.assertNotEqual(fork['cliSessionId'], source['cliSessionId'])
                self.assertNotEqual(fork['id'], source['id'])
                self.assertEqual(fork['status'], 'ready')
                self.assertIsNone(fork['lastConnectedAt'])
                self.assertTrue((destination / '.git').is_file())
                self.assertEqual(self.git('branch', '--show-current', cwd=destination), branch)
                self.assertEqual(self.git('rev-parse', 'HEAD', cwd=destination), self.git('rev-parse', 'HEAD'))
                self.assertEqual((destination / 'tracked.txt').read_text(), 'committed content')
        self.assertEqual((self.project / 'tracked.txt').read_text(), 'uncommitted content')
        self.assertEqual(self.git('branch', '--show-current'), 'main')

    def test_fork_git_failures_do_not_create_sessions(self):
        source = self.create()
        registry = self.home / '.outpost' / 'registry.json'
        original = registry.read_bytes()
        destination = self.home / 'fork'
        request = {'action': 'fork', 'id': source['id'], 'branch': 'feature/new', 'rootDir': str(destination)}
        error = self.call(request, expect_ok=False)
        self.assertEqual(error['status'], 409)
        self.assertIn('not a git repository', error['message'])
        self.assertEqual(registry.read_bytes(), original)
        self.assertFalse(destination.exists())

        self.repository()
        for branch in ('main', '--detach', 'invalid..branch', '@{-1}'):
            with self.subTest(branch=branch):
                self.call({**request, 'branch': branch}, expect_ok=False)
                self.assertEqual(registry.read_bytes(), original)
                self.assertFalse(destination.exists())
        destination.mkdir()
        (destination / 'keep.txt').write_text('keep this')
        error = self.call(request, expect_ok=False)
        self.assertIn('already exists', error['message'])
        self.assertEqual(registry.read_bytes(), original)
        self.assertEqual((destination / 'keep.txt').read_text(), 'keep this')
        self.assertEqual(self.git('branch', '--format=%(refname:short)'), 'main')

    def test_fork_preserves_literal_paths_and_avoids_name_collisions(self):
        self.repository()
        source = self.create('feature/fork')
        destination = self.home / 'fork;$(touch injected)'
        request = {'action': 'fork', 'id': source['id'], 'branch': source['name'], 'rootDir': str(destination)}
        fork = self.call(request)
        self.assertEqual(fork['name'], 'feature/fork (2)')
        self.assertEqual(fork['rootDir'], str(destination))
        self.assertFalse((self.project / 'injected').exists())
        self.assertTrue((destination / '.git').is_file())

        missing = self.call({**request, 'id': str(uuid.uuid4())}, expect_ok=False)
        self.assertEqual(missing['status'], 404)

    def test_fork_reports_created_worktree_if_harness_allocation_fails(self):
        self.repository()
        source = self.create(tool='codex')
        registry = self.home / '.outpost' / 'registry.json'
        original = registry.read_bytes()
        (self.bin / 'codex').write_text('#!/bin/sh\nexit 1\n')
        destination = self.home / 'fork-without-session'
        error = self.call(
            {'action': 'fork', 'id': source['id'], 'branch': 'feature/no-cli', 'rootDir': str(destination)},
            expect_ok=False,
        )
        self.assertEqual(error['status'], 409)
        self.assertIn('Worktree created at ' + str(destination), error['message'])
        self.assertEqual(registry.read_bytes(), original)
        self.assertEqual(self.git('branch', '--show-current', cwd=destination), 'feature/no-cli')

    def attach(self, session, cols=100, rows=30):
        process = subprocess.Popen(
            self.command({'action': 'attach', 'id': session['id'], 'cols': cols, 'rows': rows}),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            env=self.env,
        )

        def cleanup():
            if process.poll() is None:
                process.kill()
                process.wait()
            for stream in (process.stdin, process.stdout):
                stream.close()

        self.addCleanup(cleanup)
        return Connection(self, process)

    def test_lifecycle_through_the_framed_relay(self):
        session = self.create()
        self.assertEqual(session['status'], 'ready')
        self.assertEqual(session['tool'], 'claude')
        (self.project / 'capture-input').write_text('')  # Raw-mode fixture records its input.
        connection = self.attach(session)
        connection.expect_control('ready')
        connection.expect_output(b'OUTPOST_FIXTURE_READY')
        connection.expect_output(b'100x30')

        connection.send(control({'type': 'resize', 'cols': 90, 'rows': 25}))
        connection.expect_output(b'90x25')
        self.assertEqual(self.call({'action': 'get', 'id': session['id']})['status'], 'attached')

        # Images travel over the open connection and are pasted into the persistent PTY once.
        connection.send(control({'type': 'paste-image', 'id': 'p1', 'extension': 'png', 'data': PNG}))
        result = connection.expect_control('result')
        self.assertTrue(result['ok'], result)
        reference = result['reference']
        self.assertTrue(reference.startswith(str(self.home / '.outpost' / 'clipboard' / session['id'])))
        self.assertTrue(Path(reference).read_bytes().startswith(b'\x89PNG'))
        wait_for(lambda: reference.encode() in read(self.project / 'input.bin'))

        # Typed bytes are opaque data, including a bogus frame-like sequence.
        connection.send(encode(b'I', b'Cxxxx-not-a-frame'))
        wait_for(lambda: b'Cxxxx-not-a-frame' in read(self.project / 'input.bin'))

        # A remote browser request reaches the attached connection and is answered.
        helper = subprocess.Popen(
            [str(self.home / '.outpost' / 'bin' / 'outpost-browser'), 'https://example.com/x'],
            env={**self.env, 'OUTPOST_SESSION_ID': session['id']},
            stderr=subprocess.PIPE,
        )
        self.addCleanup(helper.stderr.close)
        signal = connection.expect_control('signal')
        self.assertEqual(signal['signal'], {'type': 'browser.open', 'payload': {'url': 'https://example.com/x'}})
        connection.send(control({'type': 'signal-result', 'id': signal['id'], 'ok': True}))
        self.assertEqual(helper.wait(timeout=10), 0, helper.stderr.read())

        # Closing the connection detaches; the coding process keeps running.
        pid = json.loads((self.project / 'heartbeat.json').read_text())['pid']
        connection.close()
        self.assertEqual(self.call({'action': 'get', 'id': session['id']})['status'], 'detached')
        again = self.attach(session)
        again.expect_output(b'OUTPOST_FIXTURE_READY ' + str(pid).encode())

        # Detachment closes the connection; no control key is stolen from the app.
        again.close()
        self.assertEqual(self.call({'action': 'terminate', 'id': session['id']})['status'], 'stopped')
        self.call({'action': 'delete', 'id': session['id']})
        self.assertEqual(self.call({'action': 'list'})['sessions'], [])

    def test_signals_fail_clearly_without_a_terminal(self):
        session = self.create()
        connection = self.attach(session)
        connection.expect_output(b'OUTPOST_FIXTURE_READY')
        connection.close()
        helper = subprocess.run(
            [str(self.home / '.outpost' / 'bin' / 'outpost-signal'), 'work.progress', '{}'],
            env={**self.env, 'OUTPOST_SESSION_ID': session['id']},
            capture_output=True,
            text=True,
        )
        self.assertEqual(helper.returncode, 1)
        self.assertIn('No Outpost terminal is connected', helper.stderr)

    def test_names_are_unique_and_registry_is_validated(self):
        self.create('Same')
        error = self.call(
            {'action': 'create', 'name': 'same', 'rootDir': str(self.project), 'tool': 'codex', 'env': {}, 'args': ''},
            expect_ok=False,
        )
        self.assertEqual(error['status'], 409)
        registry = self.home / '.outpost' / 'registry.json'
        data = json.loads(registry.read_text())
        self.assertEqual(data['version'], 2)
        registry.write_text(json.dumps({**data, 'extra': True}))
        error = self.call({'action': 'list'}, expect_ok=False)
        self.assertIn('Invalid session registry', error['message'])
        self.assertIn('"extra": true', registry.read_text())
        registry.write_text(json.dumps(data))

    def test_management_image_upload_pastes_into_a_running_session(self):
        session = self.create()
        stopped = self.call({'action': 'paste-image', 'id': session['id'], 'extension': 'png'}, PNG.encode())
        self.assertFalse(stopped['injected'])
        bad = self.call(
            {'action': 'paste-image', 'id': session['id'], 'extension': 'png'}, b'not base64!', expect_ok=False
        )
        self.assertEqual(bad['message'], 'Invalid image data')


class Connection:
    def __init__(self, test, process):
        self.test = test
        self.process = process
        self.decoder = FrameDecoder()
        self.output = b''
        self.controls = []
        self.started = False
        self.prefix = b''

    def send(self, data):
        self.process.stdin.write(data)
        self.process.stdin.flush()

    def pump(self, timeout=0.2):
        if not select.select([self.process.stdout], [], [], timeout)[0]:
            return
        data = os.read(self.process.stdout.fileno(), 65536)
        if not data:
            raise AssertionError('Relay ended: ' + repr(self.prefix + self.output))
        if not self.started:
            self.prefix += data
            if MAGIC not in self.prefix:
                return
            self.started = True
            data = self.prefix.split(MAGIC, 1)[1]
        for kind, payload in self.decoder.feed(data):
            if kind == b'O':
                self.output += payload
            else:
                message = json.loads(payload)
                self.controls.append(message)
                part = message.get('checkpoint', {})
                if part.get('part') == 'lines':
                    for line in part['lines']:
                        data = base64.b64decode(line['cells'])
                        cells = struct.unpack('<' + 'I' * (len(data) // 4), data)
                        text = ''
                        for column in range(len(cells) // 3):
                            value = cells[column * 3]
                            if value & 0x200000:
                                text += line['combined'].get(str(column), '')
                            elif value & 0x1FFFFF:
                                text += chr(value & 0x1FFFFF)
                            else:
                                text += ' '
                        self.output += text.rstrip().encode() + b'\n'

    def expect_output(self, marker, timeout=15):
        deadline = time.monotonic() + timeout
        while marker not in self.output:
            if time.monotonic() > deadline:
                raise AssertionError('Missing ' + repr(marker) + ' in ' + repr(self.output[-2000:]))
            self.pump()

    def expect_control(self, kind, timeout=15):
        deadline = time.monotonic() + timeout
        while True:
            for index, message in enumerate(self.controls):
                if message['type'] == kind:
                    return self.controls.pop(index)
            if time.monotonic() > deadline:
                raise AssertionError('Missing control ' + kind + ' in ' + repr(self.controls))
            self.pump()

    def close(self):
        self.process.stdin.close()
        self.test.assertEqual(self.process.wait(timeout=10), 0)


def read(path):
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return b''


def wait_for(condition, timeout=10):
    deadline = time.monotonic() + timeout
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError('Timed out')
        time.sleep(0.05)


class FrameTest(unittest.TestCase):
    def test_frames_split_across_reads(self):
        decoder = FrameDecoder()
        data = encode(b'I', b'hello') + control({'type': 'resize'})
        frames = []
        for index in range(len(data)):
            frames += decoder.feed(data[index : index + 1])
        self.assertEqual(frames, [(b'I', b'hello'), (b'C', b'{"type":"resize"}')])

    def test_oversized_frames_are_rejected(self):
        with self.assertRaises(ValueError):
            FrameDecoder().feed(struct.pack('>cI', b'I', 64 * 1024 * 1024))


if __name__ == '__main__':
    unittest.main()
