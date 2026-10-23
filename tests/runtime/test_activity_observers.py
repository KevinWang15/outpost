"""Observer correctness under conversation switches, races, corruption and heavy output."""

import io
import json
import random
import sys
import tempfile
import time
import unittest
from contextlib import contextmanager
from pathlib import Path
from threading import Event
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'runtime'))

from outpost_activity import STALE_SECONDS, stale
from outpost_activity_events import read_json, record, write_json
from outpost_activity_state import Activity
from outpost_activity_stream import READ_TIMEOUT, ActivityStream
from outpost_activity_transcript import marker, reverse_records, timestamp
from outpost_codex_state import observe as observe_codex
from outpost_harness import LiveActivity, LiveStatusUnavailable, NativeActivity, adapters

ID = '12345678-1234-4123-8123-123456789012'
OTHER = '12345678-1234-4123-8123-123456789013'
THIRD = '12345678-1234-4123-8123-123456789014'


class ObserverTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='outpost-observer-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.directory = self.root / 'activity'
        self.adapter = adapters()['claude']
        self.session = {
            'id': ID,
            'cliSessionId': ID,
            'rootDir': str(self.root),
            'env': {},
            'cliSessionEnv': self.adapter.storage(self.root / 'claude'),
        }
        self.activity = Activity(self.directory, self.adapter, self.session)
        self.activity.initialize()
        self.events = self.directory / (ID + '.events.json')
        write_json(
            self.events,
            {'generation': 'launch', 'session': ID, 'state': None, 'received': 0, 'observed': False, 'turn': None},
        )
        self.sequence = time.time_ns()

    def hook(self, event, native=ID, **values):
        self.sequence += 1_000_000
        record(self.directory, ID, 'launch', {'session_id': native, 'hook_event_name': event, **values}, self.sequence)

    def transcript(self, native=ID):
        path = self.root / 'claude' / 'projects' / 'project' / (native + '.jsonl')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()
        return path

    def append(self, path, *records):
        with path.open('a') as stream:
            for entry in records:
                stream.write(json.dumps(entry) + '\n')

    def test_native_lifecycle_waiting_completion_and_error(self):
        for event, state in [
            ('SessionStart', 'idle'),
            ('UserPromptSubmit', 'working'),
            ('PermissionRequest', 'waiting'),
            ('PostToolUse', 'working'),
            ('Elicitation', 'waiting'),
            ('ElicitationResult', 'working'),
            ('StopFailure', 'error'),
            ('UserPromptSubmit', 'working'),
            ('Stop', 'finished'),
        ]:
            self.hook(event)
            self.assertEqual(self.activity.describe(True)['state'], state, event)
        completed = self.activity.describe(True)
        self.hook('SessionEnd')
        self.assertEqual(self.activity.describe(False)['completionId'], completed['completionId'])
        self.activity.acknowledge(completed['completionId'], False)
        self.assertEqual(self.activity.describe(False)['state'], 'idle')

    def test_switches_follow_native_identity_and_ignore_old_completions_subagents_and_launches(self):
        self.hook('UserPromptSubmit', native=OTHER, turn_id='new')
        before = read_json(self.events)
        for event in ('Stop', 'SessionEnd', 'PermissionRequest'):
            self.hook(event, native=ID)
        self.hook('UserPromptSubmit', native=THIRD, agent_id='subagent')
        self.hook('SessionStart', native=THIRD, source='fork', agent_id='subagent')
        self.hook('SessionStart', source='compact')
        self.hook('Stop', native=OTHER, turn_id='old')
        record(self.directory, ID, 'old-launch', {'session_id': OTHER, 'hook_event_name': 'Stop'}, self.sequence)
        record(self.directory, ID, 'launch', {'session_id': OTHER, 'hook_event_name': 'Stop'}, 1)
        self.assertEqual(read_json(self.events), before)
        self.assertEqual(self.activity.selected_session()['cliSessionId'], OTHER)
        self.assertEqual(self.activity.describe(True)['state'], 'working')
        self.hook('Stop', native=OTHER, turn_id='new')
        self.assertEqual(self.activity.describe(True)['state'], 'finished')
        self.hook('SessionStart', native=THIRD, source='resume')
        self.assertEqual(self.activity.describe(True)['state'], 'idle')
        self.hook('SessionStart', native=ID, source='fork')
        self.assertEqual(self.activity.selected_session()['cliSessionId'], ID)

    def test_observation_retries_if_conversation_changes_during_recovery_read(self):
        self.hook('UserPromptSubmit')
        calls = []

        def files(session):
            calls.append(session['cliSessionId'])
            if len(calls) == 1:
                self.hook('SessionStart', native=OTHER, source='resume')
            return []

        with patch.object(self.adapter, 'activity_files', side_effect=files):
            self.assertEqual(self.activity.describe(True)['state'], 'idle')
        self.assertEqual(calls, [ID])  # The new Idle hook needs no recovery read.

    def test_transient_failures_preserve_last_known_state_then_expire_and_recover(self):
        self.append(self.transcript(), {'type': 'user', 'message': {'content': 'prompt'}})
        first = self.activity.describe(True)
        with patch.object(self.adapter, 'activity_files', side_effect=ValueError('temporary read failure')):
            failed = self.activity.describe(True)
        self.assertEqual(failed['state'], 'working')
        self.assertEqual(failed['observation'], 'stale')
        self.assertEqual(first['observedAt'], failed['observedAt'])
        expired = stale(failed, 'still unavailable', now=time.time() + STALE_SECONDS + 1)
        self.assertEqual(expired['state'], 'unknown')
        self.assertEqual(expired['observation'], 'unavailable')
        self.assertEqual(self.activity.describe(True)['observation'], 'current')

    def test_last_known_observation_never_crosses_conversations_or_launches(self):
        self.hook('UserPromptSubmit')
        self.activity.describe(True)
        self.hook('SessionStart', native=OTHER, source='resume')
        value = read_json(self.events)
        write_json(self.events, {**value, 'state': None, 'observed': False})
        with patch.object(self.adapter, 'live_activity', side_effect=ValueError('unavailable')):
            self.assertEqual(self.activity.describe(True)['state'], 'unknown')
        self.hook('UserPromptSubmit', native=OTHER)
        self.activity.describe(True)
        value = read_json(self.events)
        write_json(self.events, {**value, 'generation': 'next-launch', 'state': None, 'observed': False})
        with patch.object(self.adapter, 'live_activity', side_effect=ValueError('unavailable')):
            self.assertEqual(self.activity.describe(True)['state'], 'unknown')

    def test_daemon_not_owning_the_thread_uses_launch_hooks(self):
        with patch.object(self.adapter, 'live_activity', side_effect=LiveStatusUnavailable('notLoaded')):
            # A freshly launched integration can be idle before its first hook.
            self.assertEqual(self.activity.describe(True)['state'], 'idle')
            self.hook('UserPromptSubmit')
            self.assertEqual(self.activity.describe(True)['state'], 'working')
            self.events.unlink()
            self.assertEqual(self.activity.describe(True)['state'], 'unknown')

    def test_hooks_remain_current_when_secondary_sources_disagree_or_fail(self):
        for event, expected in [('UserPromptSubmit', 'working'), ('PermissionRequest', 'waiting')]:
            self.hook(event)
            with (
                patch.object(self.adapter, 'live_activity', return_value=LiveActivity('idle')) as live,
                patch.object(self.adapter, 'activity_files', side_effect=OSError('store unavailable')),
            ):
                value = self.activity.describe(True)
                self.assertEqual((value['state'], value['observation']), (expected, 'current'))
                live.assert_not_called()

    def completion_record(self):
        return {
            'type': 'assistant',
            'timestamp': timestamp((self.sequence + 1_000_000) / 1_000_000),
            'message': {'stop_reason': 'end_turn'},
        }

    def test_recovered_completion_is_durable_and_late_stop_keeps_its_acknowledgement(self):
        self.hook('UserPromptSubmit')
        self.append(self.transcript(), self.completion_record())
        completed = self.activity.describe(True)
        self.assertEqual(completed['state'], 'finished')
        self.assertEqual(read_json(self.events)['event'], 'Transcript')
        self.activity.acknowledge(completed['completionId'], True)
        with patch.object(self.adapter, 'activity_files', side_effect=OSError('store unavailable')):
            self.assertEqual(self.activity.describe(True, reconcile=False)['state'], 'idle')
            self.assertEqual(self.activity.describe(True)['state'], 'idle')
        self.sequence += 10_000_000
        self.hook('Stop')
        self.assertEqual(self.activity.describe(True)['state'], 'idle')
        self.hook('UserPromptSubmit')
        self.hook('Stop')
        self.assertNotEqual(self.activity.describe(True)['completionId'], completed['completionId'])

    def test_recovery_rejects_a_different_native_turn(self):
        self.hook('UserPromptSubmit', turn_id='current')
        record = self.completion_record()
        self.append(self.transcript(), record)
        with patch.object(
            self.adapter.sessions, 'activity_event', return_value=NativeActivity('finished', record['timestamp'], 'old')
        ):
            self.assertEqual(self.activity.describe(True)['state'], 'working')
        self.assertEqual(read_json(self.events)['event'], 'UserPromptSubmit')

    def test_recovery_cannot_overwrite_a_hook_arriving_during_its_read(self):
        self.hook('UserPromptSubmit')
        self.append(self.transcript(), self.completion_record())
        recover = self.activity.recover

        def switched(*args):
            self.sequence += 10_000_000
            self.hook('UserPromptSubmit', turn_id='new')
            return recover(*args)

        with patch.object(self.activity, 'recover', side_effect=switched):
            self.assertEqual(self.activity.describe(True)['state'], 'working')
        self.assertEqual(read_json(self.events)['turn'], 'new')

    def test_input_while_recovery_is_pending_acknowledges_the_completion(self):
        self.hook('UserPromptSubmit')
        self.append(self.transcript(), self.completion_record())
        recover = self.activity.recover

        def checked(*args):
            self.activity.input()
            return recover(*args)

        with patch.object(self.activity, 'recover', side_effect=checked):
            self.assertEqual(self.activity.describe(True)['state'], 'idle')
        self.sequence += 10_000_000
        self.hook('Stop')
        self.assertEqual(self.activity.describe(True)['state'], 'idle')

    def test_input_rechecks_completion_after_acquiring_the_checkpoint_lock(self):
        self.hook('UserPromptSubmit')
        self.append(self.transcript(), self.completion_record())
        lock = self.activity.lock

        @contextmanager
        def completed_before_lock():
            with patch.object(self.activity, 'lock', lock):
                self.assertEqual(self.activity.describe(True)['state'], 'finished')
            with lock():
                yield

        with patch.object(self.activity, 'lock', completed_before_lock):
            self.activity.input()
        self.assertEqual(self.activity.describe(True)['state'], 'idle')

    def test_cancelled_tool_is_idle_but_an_ordinary_failure_keeps_working(self):
        for interrupted, state in [(True, 'idle'), (False, 'working')]:
            self.hook('UserPromptSubmit')
            self.hook('PostToolUseFailure', is_interrupt=interrupted)
            self.assertEqual(self.activity.describe(True)['state'], state)

    def test_stream_wakes_for_hooks_and_shared_acknowledgements_without_polling(self):
        self.hook('UserPromptSubmit')
        reads = []

        def read(reconcile):
            reads.append(reconcile)
            return self.activity.describe(True, reconcile)

        def wait_state(stream, expected):
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                value = stream.poll()
                if value and value['state'] == expected:
                    return value
                time.sleep(0.01)
            self.fail('Stream did not report ' + expected)

        with patch('outpost_activity_stream.INTERVAL', 60):
            stream = ActivityStream(read, lambda token: self.activity.acknowledge(token, True), self.activity.path)
            try:
                wait_state(stream, 'working')
                self.hook('Stop')
                completed = wait_state(stream, 'finished')
                self.activity.acknowledge(completed['completionId'], True)
                wait_state(stream, 'idle')
                self.assertTrue(reads)
                self.assertFalse(any(reads), 'A wakeup should not wait for or perform recovery reads')
            finally:
                stream.close()
                if stream.worker:
                    stream.worker.join(timeout=2)

    def test_late_transcript_flush_does_not_generate_a_second_completion(self):
        self.hook('UserPromptSubmit')
        self.hook('Stop')
        completed = self.activity.describe(True)
        self.activity.acknowledge(completed['completionId'], True)
        path = self.transcript()
        self.append(
            path, {'type': 'assistant', 'timestamp': '2099-01-01T00:00:00Z', 'message': {'stop_reason': 'end_turn'}}
        )
        self.assertEqual(self.activity.describe(True)['state'], 'idle')
        path.write_text('')  # Next turn has not flushed yet.
        self.hook('UserPromptSubmit')
        self.hook('Stop')
        second = self.activity.describe(True)
        self.assertNotEqual(second['completionId'], completed['completionId'])
        self.activity.acknowledge(completed['completionId'], True)
        self.assertEqual(self.activity.describe(True)['completionId'], second['completionId'])
        self.activity.input()
        self.assertEqual(self.activity.describe(True)['state'], 'idle')

    def test_unrelated_hooks_and_duplicate_stops_do_not_realert_a_seen_completion(self):
        self.hook('UserPromptSubmit', turn_id='turn')
        self.hook('Stop', turn_id='turn')
        completed = self.activity.describe(True)
        self.activity.acknowledge(completed['completionId'], True)
        self.hook('Notification', notification_type='idle_prompt')
        self.hook('PreCompact')
        self.hook('Stop', turn_id='turn')
        self.hook('SessionEnd', turn_id='turn')
        self.assertEqual(self.activity.describe(True)['state'], 'idle')

    def test_corrupt_derived_caches_rebuild_and_metadata_contains_no_content(self):
        path = self.transcript()
        self.append(path, {'type': 'user', 'message': {'content': 'PRIVATE_PROMPT'}})
        index = self.directory / (ID + '.transcript.json')
        for invalid in ('{', '{"path":"x","end":{}}', '{"size":0,"mtime":0,"marker":[{}]}'):
            index.write_text(invalid)
            self.assertEqual(self.activity.describe(True)['state'], 'working')
        for saved in self.directory.glob('*.json'):
            self.assertNotIn('PRIVATE_PROMPT', saved.read_text())
        self.events.write_text('{"state":"anything"}')
        self.assertEqual(self.activity.describe(True)['state'], 'unknown')

    def test_rewrites_and_partial_records_do_not_reuse_old_completion(self):
        path = self.transcript()
        working = {'type': 'user', 'message': {'content': 'prompt'}}
        finished = {'type': 'assistant', 'message': {'stop_reason': 'end_turn'}}
        self.append(path, finished)
        first = self.activity.describe(True)
        self.activity.acknowledge(first['completionId'], True)
        path.write_text(json.dumps(working) + '\n')
        self.assertEqual(self.activity.describe(True)['state'], 'working')
        with path.open('a') as stream:
            stream.write(json.dumps(finished))
        self.assertEqual(self.activity.describe(True)['state'], 'working')
        with path.open('a') as stream:
            stream.write('\n')
        self.assertEqual(self.activity.describe(True)['state'], 'finished')

    def test_replacement_during_observation_cannot_ack_the_wrong_file(self):
        path = self.transcript()
        self.append(path, {'type': 'assistant', 'message': {'stop_reason': 'end_turn'}})
        completed = self.activity.describe(True)
        original = marker

        def replacing(*args):
            selected = original(*args)
            path.rename(path.with_suffix('.old'))
            path.write_text('{"type":"user","message":{"content":"new prompt"}}\n')
            return selected

        with patch('outpost_activity.marker', side_effect=replacing):
            value = self.activity.describe(True)
        self.assertEqual(value['observation'], 'stale')
        self.activity.acknowledge(completed['completionId'], True)
        self.assertEqual(self.activity.describe(True)['state'], 'working')
        self.assertIsNone(self.activity.read()['checked'])

    def test_huge_output_keeps_marker_on_cold_and_incremental_reads(self):
        path = self.transcript()
        self.append(path, {'type': 'user', 'message': {'content': 'prompt'}})
        self.assertEqual(self.activity.describe(True)['state'], 'working')
        block = json.dumps({'type': 'progress', 'data': 'x' * 65536}) + '\n'
        with path.open('a') as stream:
            stream.write(block * 200)  # >12 MiB without a lifecycle marker.
        values = [self.activity.describe(True) for _ in range(4)]
        self.assertTrue(all(value['state'] == 'working' for value in values))
        self.assertEqual(values[0]['observation'], 'stale')
        self.assertEqual(values[-1]['observation'], 'current')
        (self.directory / (ID + '.transcript.json')).unlink()
        self.assertEqual(self.activity.describe(True)['state'], 'working')
        # A warm poll has no new bytes to decode.
        with patch.object(self.adapter, 'activity_event', side_effect=AssertionError('rescanned')):
            self.assertEqual(self.activity.describe(True)['state'], 'working')

    def test_kimi_multiple_pending_approvals_errors_and_subagents(self):
        adapter = adapters()['kimi']
        path = self.root / 'wire.jsonl'
        path.touch()
        entries = [
            ({'type': 'turn.prompt'}, 'working'),
            ({'type': 'interaction.request', 'id': 'a'}, 'waiting'),
            ({'type': 'interaction.request', 'id': 'b'}, 'waiting'),
            ({'type': 'interaction.resolved', 'id': 'b'}, 'waiting'),
            ({'type': 'interaction.resolved', 'id': 'a'}, 'working'),
            ({'type': 'turn.ended', 'reason': 'completed', 'agentId': 'child'}, 'working'),
            ({'type': 'turn.ended', 'reason': 'failed'}, 'error'),
        ]
        for entry, state in entries:
            self.append(path, {'agentId': 'main', 'time': 1000, **entry})
            with self.subTest(event=entry):
                self.assertEqual(marker(self.directory, ID, adapter, path)[0][0], state)
                (self.directory / (ID + '.transcript.json')).unlink()
                self.assertEqual(marker(self.directory, ID, adapter, path)[0][0], state)

    def test_reverse_reader_matches_forward_parse_across_boundaries_and_invalid_records(self):
        randomizer = random.Random(42)
        data = bytearray()
        expected = []
        for i in range(250):
            if i % 5 == 0:
                data.extend(b'\n{invalid}\n[]\n\xff\n')
            row = {'index': i, 'value': 'x' * randomizer.randint(0, 2048)}
            data.extend(json.dumps(row).encode() + b'\n')
            expected.append((row, len(data)))
        data.extend(b'{"incomplete":')
        self.assertEqual(list(reverse_records(io.BytesIO(data), len(data))), list(reversed(expected)))

    def test_failed_installation_is_visible_without_preventing_launch(self):
        with patch.object(self.adapter, 'prepare_activity', side_effect=ValueError('broken configuration')):
            generation, arguments = self.activity.begin_launch('/test/claude')
        self.assertTrue(generation)
        self.assertEqual(arguments, [])
        value = self.activity.describe(True)
        self.assertEqual(value['state'], 'unknown')
        self.assertIn('broken configuration', value['detail'])

    def test_codex_live_states_distinguish_approval_input_errors_and_unloaded_threads(self):
        for status, expected in [
            ({'type': 'active', 'activeFlags': []}, 'working'),
            ({'type': 'active', 'activeFlags': ['waitingOnApproval']}, 'waiting'),
            ({'type': 'active', 'activeFlags': ['waitingOnUserInput']}, 'waiting'),
            ({'type': 'active', 'activeFlags': ['waitingOnApproval', 'waitingOnUserInput']}, 'waiting'),
            ({'type': 'systemError'}, 'error'),
            ({'type': 'idle'}, 'idle'),
        ]:
            with (
                self.subTest(status=status),
                patch('outpost_codex_state.read_thread', return_value={'id': ID, 'status': status}),
            ):
                self.assertEqual(observe_codex(self.root, ID, True).state, expected)
        with patch('outpost_codex_state.read_thread', return_value={'id': ID, 'status': {'type': 'notLoaded'}}):
            with self.assertRaises(LiveStatusUnavailable):
                observe_codex(self.root, ID, True)
            self.assertEqual(observe_codex(self.root, ID, False).state, 'idle')

    def test_stream_deduplicates_timestamp_refreshes_and_stalled_reads_expire(self):
        self.hook('UserPromptSubmit')
        value = self.activity.describe(True)
        stream = ActivityStream(lambda reconcile: value, lambda token: None)
        stream.worker = object()  # Drive the worker's latest-result slot deterministically.
        stream.result = value
        self.assertEqual(stream.poll()['state'], 'working')
        stream.result = {**value, 'observedAt': value['observedAt'].replace('+00:00', 'Z')}
        self.assertIsNone(stream.poll(), 'timestamp-only updates must not churn the UI')
        stream.read_started = time.monotonic() - READ_TIMEOUT - 1
        self.assertEqual(stream.poll()['observation'], 'stale')
        stream.result = {**value, 'observedAt': '2020-01-01T00:00:00+00:00'}
        self.assertEqual(stream.poll()['observation'], 'unavailable')
        stream.close()
        self.assertIsNone(stream.poll())

    def test_stuck_observation_has_one_worker_bounded_acks_and_nonblocking_shutdown(self):
        started, release = Event(), Event()
        calls = []

        def read(reconcile):
            calls.append(True)
            started.set()
            release.wait(2)
            return self.activity.describe(True, reconcile)

        stream = ActivityStream(read, lambda token: None)
        try:
            stream.poll()
            self.assertTrue(started.wait(1))
            for index in range(32):
                self.assertTrue(stream.request_acknowledgement(index, 'a' * 64))
            self.assertFalse(stream.request_acknowledgement(33, 'b' * 64))
            for _ in range(30):
                stream.poll()
            self.assertEqual(len(calls), 1)
            stream.close()
            self.assertTrue(stream.worker.is_alive(), 'shutdown did not wait for blocked I/O')
        finally:
            release.set()
            stream.worker.join(timeout=2)
        self.assertFalse(stream.worker.is_alive())


if __name__ == '__main__':
    unittest.main()
