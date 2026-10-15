"""Native turn semantics and cross-terminal acknowledgement races, without provider calls."""

import json
import shutil
import sqlite3
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'runtime'))

from outpost_activity_state import Activity
from outpost_harness import adapters
from outpost_relay import Relay

ID = '12345678-1234-4123-8123-123456789012'
TIME = '2026-10-01T00:00:00Z'


class ActivityTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='outpost-activity-')
        self.home = Path(self.directory.name)
        self.codex_threads = {}
        self.addCleanup(self.directory.cleanup)

    def fixture(self, tool):
        adapter = adapters()[tool]
        home = self.home / tool
        cli_id = 'session_fixture' if tool == 'kimi' else ID
        session = {
            'id': tool,
            'rootDir': str(self.home),
            'cliSessionId': cli_id,
            'cliSessionEnv': adapter.storage(home),
        }
        relative = {
            'codex': 'sessions/2026/10/01/rollout-test-' + ID + '.jsonl',
            'claude': 'projects/project/' + ID + '.jsonl',
            'kimi': 'sessions/project/session_fixture/agents/main/wire.jsonl',
        }[tool]
        path = home / relative
        path.parent.mkdir(parents=True)
        path.touch()
        if tool == 'codex':
            # The real Codex adapter observes the daemon and its selected rollout;
            # fixture events drive that independent native status explicitly.
            with sqlite3.connect(home / 'state_5.sqlite') as database:
                database.execute('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)')
                database.execute('INSERT INTO threads VALUES (?, ?)', (cli_id, str(path)))
            native = {'id': cli_id, 'status': {'type': 'idle'}, 'path': str(path)}
            self.codex_threads[path] = native
            reader = patch('outpost_codex_state.read_thread', return_value=native)
            reader.start()
            self.addCleanup(reader.stop)
        observer = Activity(self.home / 'activity', adapter, session)
        observer.initialize()
        return observer, path

    def append(self, path, record, complete=True):
        with path.open('a') as stream:
            stream.write(json.dumps(record) + ('\n' if complete else ''))
        if complete and path in self.codex_threads and record.get('type') == 'event_msg':
            kind = record.get('payload', {}).get('type')
            if kind in ('task_started', 'task_complete', 'turn_aborted'):
                self.codex_threads[path]['status'] = (
                    {'type': 'active', 'activeFlags': []} if kind == 'task_started' else {'type': 'idle'}
                )

    def event(self, tool, state):
        if tool == 'codex':
            return {
                'type': 'event_msg',
                'timestamp': TIME,
                'payload': {
                    'type': {'working': 'task_started', 'finished': 'task_complete', 'idle': 'turn_aborted'}[state],
                    'turn_id': 'turn',
                },
            }
        if tool == 'claude':
            if state == 'idle':
                return {
                    'type': 'user',
                    'timestamp': TIME,
                    'message': {'role': 'user', 'content': [{'type': 'text', 'text': '[Request interrupted by user]'}]},
                }
            return {
                'type': 'user' if state == 'working' else 'assistant',
                'timestamp': TIME,
                'message': {
                    'role': 'user' if state == 'working' else 'assistant',
                    'stop_reason': None if state == 'working' else 'end_turn',
                    'content': 'PRIVATE_TURN_CONTENT',
                },
            }
        return {
            'type': 'turn.prompt' if state == 'working' else 'turn.ended',
            'time': 1790812800000,
            'agentId': 'main',
            'turnId': 0,
            'reason': 'completed' if state == 'finished' else 'cancelled',
        }

    def test_lifecycle_checks_are_shared_and_new_completions_survive_stale_checks(self):
        for tool in adapters():
            with self.subTest(tool=tool):
                observer, path = self.fixture(tool)
                self.assertEqual(observer.describe(True)['state'], 'idle')
                self.append(path, self.event(tool, 'working'))
                self.assertEqual(observer.describe(True)['state'], 'working')
                self.assertEqual(
                    observer.describe(False)['state'],
                    'working' if tool == 'codex' else 'idle',
                    'a live Codex daemon turn can outlive its terminal process',
                )
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
            if tool == 'codex':
                self.codex_threads[path]['status'] = {'type': 'idle'}
            self.assertEqual(observer.describe(True)['state'], 'finished')

    def test_input_checkpoints_cannot_move_backwards_across_terminals(self):
        for tool in adapters():
            with self.subTest(tool=tool):
                observer, path = self.fixture(tool)
                other = Activity(observer.directory, observer.adapter, observer.session)
                self.append(path, self.event(tool, 'finished'))
                original_lock = observer.lock

                @contextmanager
                def after_another_terminal(path=path, tool=tool, other=other, original_lock=original_lock):
                    # The first input waits for the lock while another terminal
                    # checks a completion which just arrived.
                    self.append(path, self.event(tool, 'finished'))
                    other.input()
                    with original_lock():
                        yield

                observer.lock = after_another_terminal
                observer.input()
                self.assertEqual(
                    observer.describe(True)['state'], 'idle', 'an older input must not restore an already checked badge'
                )

    def test_restarting_and_importing_dont_replay_old_turns(self):
        for tool in adapters():
            observer, path = self.fixture(tool)
            for state in ('finished', 'working'):
                self.append(path, self.event(tool, state))
                observer.initialize()
                self.assertEqual(
                    observer.describe(True)['state'], 'working' if tool == 'codex' and state == 'working' else 'idle'
                )
            self.append(path, self.event(tool, 'working'))
            self.assertEqual(observer.describe(True)['state'], 'working')

    def test_interrupts_errors_tools_and_subagents_are_not_main_turn_completion(self):
        for tool in adapters():
            observer, path = self.fixture(tool)
            self.append(path, self.event(tool, 'working'))
            ignored = {
                'codex': {'type': 'event_msg', 'payload': {'type': 'agent_message', 'message': 'task_complete'}},
                'claude': {**self.event(tool, 'finished'), 'isSidechain': True},
                'kimi': {**self.event(tool, 'finished'), 'agentId': 'subagent'},
            }[tool]
            self.append(path, ignored)
            self.assertEqual(observer.describe(True)['state'], 'working')
            self.append(path, self.event(tool, 'idle'))
            self.assertEqual(observer.describe(True)['state'], 'idle')
        claude = adapters()['claude']
        self.assertEqual(
            claude.activity_event({'type': 'assistant', 'message': {'stop_reason': 'tool_use'}})[0], 'working'
        )
        self.assertEqual(
            claude.activity_event({'type': 'user', 'message': {'content': [{'type': 'tool_result'}]}})[0], 'working'
        )
        self.assertEqual(claude.activity_event({'type': 'system', 'subtype': 'api_error'})[0], 'idle')
        self.assertEqual(
            claude.activity_event({'type': 'assistant', 'isApiErrorMessage': True, 'message': {'stop_reason': None}})[
                0
            ],
            'idle',
        )

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
        self.append(path, self.event('codex', 'finished'))
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
        self.assertEqual(observer.describe(True)['state'], 'unknown')

    def test_focus_reports_dont_ack_but_user_input_does(self):
        seen = []

        class Hooks:
            def on_input(self):
                seen.append(True)

        relay = Relay('unused', 80, 24, Hooks())
        for data in (b'', b'\x1b[I', b'\x1b[O'):
            relay.observed(data)
        self.assertEqual(seen, [])
        for data in (b'x', b'\r', b'\x1b[A', b'\x1b[200~hello\x1b[201~'):
            relay.observed(data)
        self.assertEqual(len(seen), 4)


if __name__ == '__main__':
    unittest.main()
