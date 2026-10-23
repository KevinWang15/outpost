"""Real CLI lifecycle tests in disposable stores, with a loopback model fixture."""

import fcntl
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Event, Thread

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'runtime'))

from outpost_activity_events import read_json, write_json
from outpost_activity_state import Activity
from outpost_config import toml
from outpost_harness import adapters
from outpost_mcp_install import install as install_mcp
from outpost_rpc import JsonRpcProcess

ID = '12345678-1234-4123-8123-123456789012'


class LocalProvider:
    """Only the model response is faked; the CLI, native hooks and logs are real."""

    def __init__(self):
        self.requested, self.release = Event(), Event()
        self.fail = False
        provider = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers.get('content-length', 0)))
                if self.path.split('?')[0].endswith('/count_tokens'):
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b'{"input_tokens":1}')
                    return
                provider.requested.set()
                provider.release.wait(10)
                if provider.fail:
                    data = b'{"type":"error","error":{"type":"authentication_error","message":"fixture failure"}}'
                    self.send_response(401)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                usage = {'input_tokens': 1, 'output_tokens': 1}
                if '/messages' in self.path:
                    events = [
                        {
                            'type': 'message_start',
                            'message': {
                                'id': 'msg_test',
                                'type': 'message',
                                'role': 'assistant',
                                'model': 'test',
                                'content': [],
                                'stop_reason': None,
                                'usage': usage,
                            },
                        },
                        {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}},
                        {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': 'done'}},
                        {'type': 'content_block_stop', 'index': 0},
                        {
                            'type': 'message_delta',
                            'delta': {'stop_reason': 'end_turn', 'stop_sequence': None},
                            'usage': {'output_tokens': 1},
                        },
                        {'type': 'message_stop'},
                    ]
                elif '/responses' in self.path:
                    events = [
                        {'type': 'response.created', 'response': {'id': 'resp_test'}},
                        {
                            'type': 'response.output_item.done',
                            'item': {
                                'id': 'msg_test',
                                'type': 'message',
                                'role': 'assistant',
                                'content': [{'type': 'output_text', 'text': 'done'}],
                            },
                        },
                        {
                            'type': 'response.completed',
                            'response': {'id': 'resp_test', 'usage': {**usage, 'total_tokens': 2}},
                        },
                    ]
                else:
                    events = [
                        {
                            'id': 'chat_test',
                            'object': 'chat.completion.chunk',
                            'model': 'fake',
                            'created': 1,
                            'choices': [
                                {'index': 0, 'delta': {'role': 'assistant', 'content': 'done'}, 'finish_reason': None}
                            ],
                        },
                        {
                            'id': 'chat_test',
                            'object': 'chat.completion.chunk',
                            'model': 'fake',
                            'created': 1,
                            'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}],
                        },
                    ]
                data = ''.join(
                    ('event: ' + event['type'] + '\n' if 'type' in event else '')
                    + 'data: '
                    + json.dumps(event)
                    + '\n\n'
                    for event in events
                )
                if '/chat/completions' in self.path:
                    data += 'data: [DONE]\n\n'
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(data.encode())))
                self.end_headers()
                self.wfile.write(data.encode())

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = 'http://127.0.0.1:' + str(self.server.server_port)

    def close(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


@unittest.skipUnless(os.environ.get('OUTPOST_TEST_NATIVE_ACTIVITY') == '1', 'opt-in native CLI tests')
class NativeActivityTests(unittest.TestCase):
    def provider(self):
        provider = LocalProvider()
        self.addCleanup(provider.close)
        return provider

    def await_state(self, path, state):
        deadline = time.monotonic() + 8
        while read_json(path).get('state') != state and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual(read_json(path).get('state'), state, read_json(path))

    def observer(self, tool, directory, session, native):
        observer = Activity(directory, adapters()[tool], {**session, 'cliSessionId': native})
        observer.initialize()
        return observer

    def await_observation(self, observer, state):
        deadline = time.monotonic() + 8
        value = observer.describe(True)
        while value['state'] != state and time.monotonic() < deadline:
            time.sleep(0.03)
            value = observer.describe(True)
        self.assertEqual(value['state'], state, value)
        self.assertEqual(value['observation'], 'current')
        return value

    def codex_options(self, directory, session, executable, provider):
        options = adapters()['codex'].prepare_activity(directory, session, 'test', executable)
        options.extend(
            [
                '-c',
                'model_provider="activity_test"',
                '-c',
                'model_providers.activity_test='
                + toml(
                    {
                        'name': 'Test',
                        'base_url': provider.url,
                        'wire_api': 'responses',
                        'requires_openai_auth': False,
                        'request_max_retries': 0,
                        'stream_max_retries': 0,
                    }
                ),
            ]
        )
        return options

    def fixture(self, tool, key):
        directory = tempfile.TemporaryDirectory(prefix="outpost-native-' activity-")
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        home = root / tool
        home.mkdir()
        activity = root / '.outpost' / 'activity'
        session = {'id': ID, 'rootDir': str(root), 'env': {}, 'cliSessionEnv': {key: str(home)}}
        path = activity / (ID + '.events.json')
        write_json(
            path, {'generation': 'test', 'session': ID, 'state': None, 'turn': None, 'received': 0, 'observed': False}
        )
        write_json(activity.parent / 'registry.json', {'sessions': [{'id': ID}]})
        helpers = activity.parent / 'bin'
        helpers.mkdir()
        install_mcp(helpers)
        environment = {
            **os.environ,
            **session['cliSessionEnv'],
            'HOME': str(root),
            'OUTPOST_SESSION_ID': ID,
            'OUTPOST_STATE_DIRECTORY': str(activity.parent),
            'OUTPOST_ACTIVITY_GENERATION': 'test',
            'OUTPOST_ACTIVITY_HARNESS': tool,
            'OUTPOST_ACTIVITY_DIRECTORY': str(activity),
        }
        executable = shutil.which(tool)
        if executable is None:
            self.skipTest(tool + ' is not installed')
        return root, activity, session, path, environment, executable

    def test_codex_only_generated_hooks_are_trusted_and_session_start_reports_identity(self):
        root, directory, session, path, env, executable = self.fixture('codex', 'CODEX_HOME')
        provider = self.provider()
        # A user hook must remain untrusted. Outpost never grants blanket trust.
        Path(env['CODEX_HOME'], 'config.toml').write_text(
            'hooks.Stop = [{hooks=[{type="command",command="echo user-hook"}]}]\n'
        )
        options = self.codex_options(directory, session, executable, provider)
        with JsonRpcProcess([executable, 'app-server', *options], env, str(root)) as process:
            process.call(
                'initialize',
                {
                    'clientInfo': {'name': 'outpost_native_test', 'version': '1.0'},
                    'capabilities': {'experimentalApi': True},
                },
            )
            process.send({'method': 'initialized', 'params': {}})
            response = process.call('hooks/list', {'cwds': [str(root)]})
            hooks = [hook for entry in response['data'] for hook in entry['hooks']]
            own = [hook for hook in hooks if hook['source'] == 'sessionFlags']
            self.assertEqual(len(own), 8)
            self.assertTrue(all(hook['trustStatus'] == 'trusted' for hook in own), own)
            user_hook = next(hook for hook in hooks if hook['command'] == 'echo user-hook')
            self.assertEqual(user_hook['trustStatus'], 'untrusted')
            thread = process.call('thread/start', {'cwd': str(root)})['thread']['id']
            observer = self.observer('codex', directory, session, thread)
            # Codex queues SessionStart until the first submitted turn. The
            # provider is loopback-only, so no real model or credential is used.
            process.call('turn/start', {'threadId': thread, 'input': [{'type': 'text', 'text': 'hook test'}]})
            deadline = time.monotonic() + 3
            while not read_json(path)['observed'] and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertEqual(read_json(path)['session'], thread)
            self.assertIn(read_json(path)['event'], ('SessionStart', 'UserPromptSubmit'))
            self.assertTrue(provider.requested.wait(5), 'The native model request did not arrive')
            self.await_state(path, 'working')
            provider.release.set()
            self.await_state(path, 'finished')
            completed = self.await_observation(observer, 'finished')
            observer.acknowledge(completed['completionId'], True)
            self.assertEqual(observer.describe(True)['state'], 'idle')
            provider.fail = True
            other = process.call('thread/start', {'cwd': str(root)})['thread']['id']
            process.call('turn/start', {'threadId': other, 'input': [{'type': 'text', 'text': 'failure test'}]})
            self.await_observation(observer, 'error')
            self.assertEqual(observer.selected_session()['cliSessionId'], other)
        self.assertNotIn('outpost', Path(env['CODEX_HOME'], 'config.toml').read_text())
        # Invocation-only observer trust must also preserve trust the user has
        # already granted. Exercise the native config merge rather than mimic it.
        config = Path(env['CODEX_HOME'], 'config.toml')
        saved = (
            config.read_text()
            + '\n[hooks.state]\n'
            + toml(user_hook['key'])
            + '='
            + toml(
                {
                    'enabled': True,
                    'trusted_hash': user_hook['currentHash'],
                }
            )
            + '\n'
        )
        config.write_text(saved)
        with JsonRpcProcess([executable, 'app-server', *options], env, str(root)) as process:
            process.call(
                'initialize',
                {
                    'clientInfo': {'name': 'outpost_native_test', 'version': '1.0'},
                    'capabilities': {'experimentalApi': True},
                },
            )
            process.send({'method': 'initialized', 'params': {}})
            response = process.call('hooks/list', {'cwds': [str(root)]})
            hooks = [hook for entry in response['data'] for hook in entry['hooks']]
            self.assertTrue(all(hook['trustStatus'] == 'trusted' for hook in hooks), hooks)
        self.assertEqual(config.read_text(), saved)

    def test_codex_interactive_terminal_receives_launch_hooks(self):
        root, directory, session, path, env, executable = self.fixture('codex', 'CODEX_HOME')
        provider = self.provider()
        options = self.codex_options(directory, session, executable, provider)
        options.extend(['-c', 'projects=' + toml({str(root): {'trust_level': 'trusted'}})])
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 110, 0, 0))
        process = subprocess.Popen(
            [executable, '--no-alt-screen', *options],
            cwd=root,
            env={**env, 'TERM': 'xterm-256color'},
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
        )
        os.close(slave)
        sent_at, entered, output = None, False, b''
        started = time.monotonic()
        try:
            while time.monotonic() - started < 15 and process.poll() is None:
                if select.select([master], [], [], 0.05)[0]:
                    try:
                        chunk = os.read(master, 65536)
                    except OSError:
                        break
                    output = (output + chunk)[-32000:]
                    # Respond to the real TUI's terminal queries.
                    if b'\x1b[6n' in chunk:
                        os.write(master, b'\x1b[1;1R')
                    if b'\x1b]11;?' in chunk:
                        os.write(master, b'\x1b]11;rgb:1010/1010/1010\x1b\\')
                plain = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', output)
                if sent_at is None and time.monotonic() - started > 2 and b'Ask Codex' in plain:
                    os.write(master, b'hook test')
                    sent_at = time.monotonic()
                if sent_at is not None and not entered and time.monotonic() - sent_at > 0.3:
                    # Separating Enter from a text burst avoids paste detection.
                    os.write(master, b'\r')
                    entered = True
                if provider.requested.is_set():
                    provider.release.set()
                if read_json(path).get('state') == 'finished':
                    break
            self.assertTrue(provider.requested.is_set(), 'Interactive Codex did not submit its turn')
            self.assertEqual(read_json(path).get('state'), 'finished')
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            os.close(master)

    def test_kimi_local_plugin_reports_session_identity(self):
        root, directory, session, path, env, executable = self.fixture('kimi', 'KIMI_CODE_HOME')
        # CLI HOME may be customized independently of Outpost's metadata home.
        alternate = root / 'alternate home'
        alternate.mkdir()
        env['HOME'] = str(alternate)
        provider = self.provider()
        adapters()['kimi'].prepare_launch(directory.parent, session)
        adapters()['kimi'].prepare_launch(directory.parent, session)
        Path(env['KIMI_CODE_HOME'], 'config.toml').write_text(
            'defaultModel="fake"\n[models.fake]\nname="fake"\nprotocol="openai"\n'
            'baseUrl="' + provider.url + '"\napiKey="test-token"\nmaxContextSize=8192\n'
        )
        registry = read_json(Path(env['KIMI_CODE_HOME']) / 'plugins' / 'installed.json')
        self.assertEqual(len(registry['plugins']), 1)
        with JsonRpcProcess([executable, 'acp'], env, str(root)) as process:
            process.call(
                'initialize',
                {
                    'protocolVersion': 1,
                    'clientCapabilities': {},
                    'clientInfo': {'name': 'outpost_native_test', 'version': '1.0'},
                },
            )
            native = process.call('session/new', {'cwd': str(root), 'mcpServers': []})['sessionId']
            deadline = time.monotonic() + 3
            while not read_json(path)['observed'] and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertEqual(read_json(path)['session'], native)
            self.assertTrue(read_json(path)['observed'])
            self.assertIsNone(read_json(path)['state'], 'Kimi subagent lifecycle hooks are not authoritative')
            observer = self.observer('kimi', directory, session, native)
            provider.release.set()
            response = process.call(
                'session/prompt',
                {
                    'sessionId': native,
                    'prompt': [{'type': 'text', 'text': 'hook test'}],
                },
            )
            self.assertEqual(response['stopReason'], 'end_turn')
            self.assertTrue(provider.requested.is_set())
            completed = self.await_observation(observer, 'finished')
            observer.acknowledge(completed['completionId'], True)
            self.assertEqual(observer.describe(True)['state'], 'idle')
            provider.fail = True
            try:
                process.call(
                    'session/prompt', {'sessionId': native, 'prompt': [{'type': 'text', 'text': 'failure test'}]}
                )
            except ValueError:
                pass  # ACP may report the turn error in its response as well.
            self.await_observation(observer, 'error')

    def test_claude_launch_settings_report_identity_and_main_turn(self):
        for failure in (False, True):
            with self.subTest(failure=failure):
                self.claude_turn(failure)

    def claude_turn(self, failure):
        root, directory, session, path, env, executable = self.fixture('claude', 'CLAUDE_CONFIG_DIR')
        provider = self.provider()
        provider.fail = failure
        env.update(
            ANTHROPIC_BASE_URL=provider.url,
            ANTHROPIC_API_KEY='test-key',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',
            API_TIMEOUT_MS='1000',
        )
        options = adapters()['claude'].prepare_activity(directory, session, 'test', executable)
        observer = self.observer('claude', directory, session, ID)
        process = subprocess.Popen(
            [executable, '--print', '--session-id', ID, *options, 'hook test'],
            cwd=root,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline:
                if read_json(path).get('state') == 'working':
                    break
                if process.poll() is not None:
                    break
                time.sleep(0.02)
            value = read_json(path)
            self.assertTrue(value['observed'], value)
            self.assertEqual(value['session'], ID)
            self.assertEqual(value['state'], 'working')
            self.assertEqual(value['event'], 'UserPromptSubmit')
            self.assertTrue(provider.requested.wait(5), 'The native model request did not arrive')
            provider.release.set()
            if not failure:
                self.await_state(path, 'finished')
            # Some Claude authentication failures exit without StopFailure.
            # The observer must still detect the native transcript's API error.
            value = self.await_observation(observer, 'error' if failure else 'finished')
            if not failure:
                observer.acknowledge(value['completionId'], True)
                self.assertEqual(observer.describe(True)['state'], 'idle')
        finally:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == '__main__':
    unittest.main()
