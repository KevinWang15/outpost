"""Native turn semantics and cross-terminal acknowledgement races, without provider calls."""
from contextlib import contextmanager
import json
from pathlib import Path
import shutil
import sys
import tempfile
import types
import unittest

backend = Path(__file__).resolve().parents[2] / 'backend'
for name, path in [
    ('outpost_coding_protocol', 'coding_protocol.py'),
    ('outpost_activity_state', 'activity_state.py'),
    ('outpost_coding_activity', 'coding_activity.py'),
    ('outpost_coding_sessions', 'coding_sessions.py'),
    ('outpost_coding_rpc', 'coding_rpc.py'),
    ('outpost_terminal_attachment', 'terminal_attachment.py'),
    *[('outpost_' + tool + '_store', 'coding_adapters/' + tool + '_store.py') for tool in ('codex', 'claude', 'kimi')],
    *[('outpost_' + tool + '_adapter', 'coding_adapters/' + tool + '.py') for tool in ('codex', 'claude', 'kimi')],
]:
    module = types.ModuleType(name)
    sys.modules[name] = module
    exec(compile((backend / path).read_text(), path, 'exec'), module.__dict__)

from outpost_activity_state import Activity
from outpost_coding_protocol import adapters
from outpost_terminal_attachment import InputObserver

ID = '12345678-1234-4123-8123-123456789012'
TIME = '2026-10-01T00:00:00Z'


class ActivityTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='outpost-activity-')
        self.home = Path(self.directory.name)
        self.addCleanup(self.directory.cleanup)

    def fixture(self, tool):
        adapter = adapters()[tool]
        home = self.home / tool
        cli_id = 'session_fixture' if tool == 'kimi' else ID
        session = {'id': tool, 'rootDir': str(self.home), 'cliSessionId': cli_id,
                   'cliSessionEnv': adapter.storage(home)}
        relative = {'codex': 'sessions/2026/10/01/rollout-test-' + ID + '.jsonl',
                    'claude': 'projects/project/' + ID + '.jsonl',
                    'kimi': 'sessions/project/session_fixture/agents/main/wire.jsonl'}[tool]
        path = home / relative
        path.parent.mkdir(parents=True)
        path.touch()
        observer = Activity(self.home / 'activity', adapter, session)
        observer.initialize()
        return observer, path

    def append(self, path, record, complete=True):
        with path.open('a') as stream:
            stream.write(json.dumps(record) + ('\n' if complete else ''))

    def event(self, tool, state):
        if tool == 'codex':
            return {'type': 'event_msg', 'timestamp': TIME, 'payload': {
                'type': {'working': 'task_started', 'finished': 'task_complete', 'idle': 'turn_aborted'}[state], 'turn_id': 'turn'}}
        if tool == 'claude':
            if state == 'idle':
                return {'type': 'user', 'timestamp': TIME, 'message': {'role': 'user', 'content': [
                    {'type': 'text', 'text': '[Request interrupted by user]'}]}}
            return {'type': 'user' if state == 'working' else 'assistant', 'timestamp': TIME,
                    'message': {'role': 'user' if state == 'working' else 'assistant',
                                'stop_reason': None if state == 'working' else 'end_turn', 'content': 'PRIVATE_TURN_CONTENT'}}
        return {'type': 'turn.prompt' if state == 'working' else 'turn.ended', 'time': 1790812800000,
                'agentId': 'main', 'turnId': 0, 'reason': 'completed' if state == 'finished' else 'cancelled'}

    def test_lifecycle_checks_are_shared_and_new_completions_survive_stale_checks(self):
        for tool in adapters():
            with self.subTest(tool=tool):
                observer, path = self.fixture(tool)
                self.assertEqual(observer.describe(True)['state'], 'idle')
                self.append(path, self.event(tool, 'working'))
                self.assertEqual(observer.describe(True)['state'], 'working')
                self.assertEqual(observer.describe(False)['state'], 'idle', 'exited processes cannot keep working')
                self.append(path, self.event(tool, 'finished'))
                first = observer.describe(True)
                self.assertEqual(first['state'], 'finished')
                self.assertEqual(observer.describe(False)['state'], 'finished', 'completion survives CLI exit')
                before = observer.path.read_bytes()
                self.assertEqual(observer.describe(True), first)
                self.assertEqual(observer.path.read_bytes(), before, 'polling never marks a turn read')
                observer.acknowledge(first['completionId'], True)
                self.assertEqual(observer.describe(True)['state'], 'idle')
                self.append(path, self.event(tool, 'working'))
                self.append(path, self.event(tool, 'finished'))
                second = observer.describe(True)
                self.assertNotEqual(second['completionId'], first['completionId'])
                observer.acknowledge(first['completionId'], True)
                self.assertEqual(observer.describe(True), second, 'another browser cannot clear a newer completion')
                observer.input()
                self.assertEqual(observer.describe(True)['state'], 'idle')
                self.assertNotIn('PRIVATE_TURN_CONTENT', observer.path.read_text())

    def test_input_while_working_does_not_ack_a_future_finish_even_with_identical_timestamps(self):
        for tool in adapters():
            observer, path = self.fixture(tool)
            self.append(path, self.event(tool, 'working'))
            observer.input()
            self.assertEqual(observer.describe(True)['state'], 'working')
            self.append(path, self.event(tool, 'finished'), complete=False)
            observer.input()
            self.assertEqual(observer.describe(True)['state'], 'working')
            with path.open('a') as stream:
                stream.write('\n')
            self.assertEqual(observer.describe(True)['state'], 'finished')

    def test_input_checkpoints_cannot_move_backwards_across_terminals(self):
        for tool in adapters():
            with self.subTest(tool=tool):
                observer, path = self.fixture(tool)
                other = Activity(observer.directory, observer.adapter, observer.session)
                self.append(path, self.event(tool, 'finished'))
                original_lock = observer.lock

                @contextmanager
                def after_another_terminal():
                    # The first input waits for the lock while another terminal
                    # checks a completion which just arrived.
                    self.append(path, self.event(tool, 'finished'))
                    other.input()
                    with original_lock():
                        yield

                observer.lock = after_another_terminal
                observer.input()
                self.assertEqual(observer.describe(True)['state'], 'idle',
                                 'an older input must not restore an already checked badge')

    def test_restarting_and_importing_dont_replay_old_turns(self):
        for tool in adapters():
            observer, path = self.fixture(tool)
            for state in ('finished', 'working'):
                self.append(path, self.event(tool, state))
                observer.initialize()
                self.assertEqual(observer.describe(True)['state'], 'idle')
            self.append(path, self.event(tool, 'working'))
            self.assertEqual(observer.describe(True)['state'], 'working')

    def test_interrupts_errors_tools_and_subagents_are_not_main_turn_completion(self):
        for tool in adapters():
            observer, path = self.fixture(tool)
            self.append(path, self.event(tool, 'working'))
            ignored = {'codex': {'type': 'event_msg', 'payload': {'type': 'agent_message', 'message': 'task_complete'}},
                       'claude': {**self.event(tool, 'finished'), 'isSidechain': True},
                       'kimi': {**self.event(tool, 'finished'), 'agentId': 'subagent'}}[tool]
            self.append(path, ignored)
            self.assertEqual(observer.describe(True)['state'], 'working')
            self.append(path, self.event(tool, 'idle'))
            self.assertEqual(observer.describe(True)['state'], 'idle')
        claude = adapters()['claude']
        self.assertEqual(claude.activity_event({'type': 'assistant', 'message': {'stop_reason': 'tool_use'}})[0], 'working')
        self.assertEqual(claude.activity_event({'type': 'user', 'message': {'content': [{'type': 'tool_result'}]}})[0], 'working')
        self.assertEqual(claude.activity_event({'type': 'system', 'subtype': 'api_error'})[0], 'idle')
        self.assertEqual(claude.activity_event({'type': 'assistant', 'isApiErrorMessage': True, 'message': {'stop_reason': None}})[0], 'idle')

    def test_claude_delayed_prompts_do_not_hide_newer_completion_or_errors(self):
        observer, path = self.fixture('claude')
        prompt = self.event('claude', 'working')
        completed = {**self.event('claude', 'finished'), 'timestamp': '2026-10-01T00:00:01Z'}
        self.append(path, completed)
        self.append(path, prompt)  # Native flush order can differ from event order.
        first = observer.describe(False)
        self.assertEqual(first['state'], 'finished')
        observer.acknowledge(first['completionId'], False)
        self.assertEqual(observer.describe(False)['state'], 'idle')
        self.append(path, {**prompt, 'timestamp': '2026-10-01T00:00:02Z'})
        self.assertEqual(observer.describe(True)['state'], 'working')
        self.append(path, {**completed, 'timestamp': '2026-10-01T00:00:03Z'})
        second = observer.describe(False)
        self.assertEqual(second['state'], 'finished')
        observer.acknowledge(first['completionId'], False)
        self.assertEqual(observer.describe(False), second)
        self.append(path, {'type': 'system', 'subtype': 'api_error', 'timestamp': '2026-10-01T00:00:05Z'})
        self.append(path, {**prompt, 'timestamp': '2026-10-01T00:00:04Z'})
        self.assertEqual(observer.describe(False)['state'], 'idle', 'delayed prompt must not hide a provider error')
        self.assertEqual(observer.describe(True)['state'], 'idle')

    def test_claude_timestamp_selection_stays_within_the_bounded_tail(self):
        observer, path = self.fixture('claude')
        self.append(path, {'type': 'attachment', 'payload': 'x' * (4 * 1024 * 1024)})
        self.assertIsNotNone(observer.describe(False)['detail'])
        self.append(path, self.event('claude', 'finished'))
        result = observer.describe(False)
        self.assertEqual(result['state'], 'finished')
        self.assertIsNone(result['detail'])

    def test_rewritten_transcripts_cannot_inherit_acknowledgements(self):
        observer, path = self.fixture('claude')
        self.append(path, self.event('claude', 'finished'))
        observer.input()
        path.write_text(json.dumps({**self.event('claude', 'finished'), 'timestamp': '2026-10-01T01:00:00Z'}) + '\n')
        self.assertEqual(observer.describe(True)['state'], 'finished')
        observer.input()
        moved = path.with_name('moved.jsonl')
        shutil.move(path, moved)
        shutil.move(moved, path)
        self.assertEqual(observer.describe(True)['state'], 'idle')

    def test_detection_is_bounded_and_missing_or_corrupt_metadata_is_visible(self):
        observer, path = self.fixture('codex')
        self.append(path, self.event('codex', 'working'))
        self.append(path, {'type': 'response_item', 'payload': 'x' * (4 * 1024 * 1024)})
        self.assertIsNotNone(observer.describe(True)['detail'])
        observer.path.write_text('{}')
        self.assertIn('current schema', observer.describe(True)['detail'])
        observer.path.unlink()
        self.assertIn('Activity unavailable', observer.describe(True)['detail'])

    def test_symlinks_cannot_read_another_store(self):
        observer, path = self.fixture('codex')
        outside = self.home / 'secret.jsonl'
        outside.write_text(json.dumps(self.event('codex', 'finished')) + '\n')
        path.unlink()
        path.symlink_to(outside)
        self.assertEqual(observer.describe(True)['state'], 'idle')

    def test_terminal_replies_and_focus_out_dont_ack_but_typing_paste_and_focus_in_do(self):
        seen = []
        observer = InputObserver(lambda: seen.append(True))
        for data in (b'\x1b[?1;2c', b'\x1b[>0;276;0c', b'\x1b[1;2R', b'\x1b[?7u', b'\x1b[O',
                     b'\x1b]11;rgb:0000/0000/0000\x07'):
            observer.feed(data)
        observer.feed(b'\x1b[?')
        observer.feed(b'1;2c')
        self.assertEqual(seen, [])
        for data in (b'x', b'\r', b'\x1b[A', b'\x1b[I', b'\x1b[200~hello\x1b[201~'):
            observer.feed(data)
        self.assertGreaterEqual(len(seen), 5)


unittest.main()
