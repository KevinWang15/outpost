"""Native formats, incremental checkpoints, source confinement, and default MCP registration."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'runtime'))

import outpost_history as history
import outpost_mcp_install


class HistoryTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='outpost-history-')
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        self.environment = {
            'HOME': str(self.home),
            'CODEX_HOME': str(self.home / '.codex'),
            'CLAUDE_CONFIG_DIR': str(self.home / '.claude'),
            'KIMI_CODE_HOME': str(self.home / '.kimi-code'),
        }
        self.patch = patch.dict(os.environ, self.environment)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.codex = str(uuid.uuid4())
        self.claude = str(uuid.uuid4())
        self.codex_path = self.home / '.codex/sessions/2026/11/11' / ('rollout-' + self.codex + '.jsonl')

    def put(self, path, records):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(''.join(json.dumps(record, ensure_ascii=False) + '\n' for record in records))

    def populate(self):
        self.put(
            self.codex_path,
            [
                {
                    'type': 'session_meta',
                    'payload': {
                        'id': self.codex,
                        'cwd': '/work/project',
                        'base_instructions': 'PRIVATE_CONFIGURATION_NOT_CHAT',
                    },
                },
                {
                    'type': 'response_item',
                    'timestamp': '2026-11-01T12:00:00Z',
                    'payload': {
                        'type': 'message',
                        'role': 'user',
                        'content': [{'type': 'input_text', 'text': 'Fix 缓存失效'}],
                    },
                },
                {'type': 'event_msg', 'payload': {'type': 'user_message', 'message': 'Fix 缓存失效'}},
                {'type': 'response_item', 'payload': {'type': 'function_call_output', 'output': 'cache tool output'}},
            ],
        )
        self.put(
            self.home / '.claude/projects/project' / (self.claude + '.jsonl'),
            [
                {'type': 'user', 'cwd': '/work/project', 'message': {'content': 'Find the configuration bug'}},
                {'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': 'Claude diagnosis'}]}},
            ],
        )
        self.put(
            self.home / '.claude/projects/project' / self.claude / 'subagents/agent-one.jsonl',
            [
                {'type': 'assistant', 'message': {'content': 'Subagent diagnosis'}},
            ],
        )
        kimi = self.home / '.kimi-code/sessions/project/session_example'
        (kimi / 'agents/main').mkdir(parents=True)
        (kimi / 'state.json').write_text(json.dumps({'title': 'Kimi debugging'}))
        self.put(
            self.home / '.kimi-code/session_index.jsonl', [{'sessionId': 'session_example', 'workDir': '/work/kimi'}]
        )
        self.put(
            kimi / 'agents/main/wire.jsonl',
            [
                {
                    'type': 'context.append_message',
                    'time': '2026-11-02T12:00:00Z',
                    'message': {'role': 'user', 'content': 'Kimi request'},
                },
                {
                    'type': 'context.append_message',
                    'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'Kimi answer'}]},
                },
            ],
        )

    def test_all_native_stores_subagents_and_default_mcp_tools(self):
        self.populate()
        sources = []
        after = None
        while True:
            page = history.catalog([], after, limit=2)
            sources.extend(page['sources'])
            after = page['next']
            if after is None:
                break
        self.assertEqual(len(sources), 4)
        self.assertEqual({source['tool'] for source in sources}, {'claude', 'codex', 'kimi'})
        batch = history.read_batch([], [{'source': source} for source in sources])
        messages = [message for file in batch['files'] for message in file['messages']]
        self.assertEqual(len(messages), 7)
        self.assertEqual(sum(message['text'] == 'Fix 缓存失效' for message in messages), 1)
        self.assertNotIn('PRIVATE_CONFIGURATION_NOT_CHAT', json.dumps(messages))
        self.assertTrue(any(m['role'] == 'tool' for m in messages))
        state = self.home / '.outpost'
        (state / 'bin').mkdir(parents=True)
        identifier = str(uuid.uuid4())
        (state / 'registry.json').write_text(json.dumps({'sessions': [{'id': identifier}]}))
        executable = outpost_mcp_install.install(state / 'bin')
        requests = [
            {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18'}},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
        ]
        for tool in ('claude', 'codex', 'kimi'):
            result = subprocess.run(
                [sys.executable, '-I', str(executable)],
                input=''.join(json.dumps(r) + '\n' for r in requests),
                text=True,
                capture_output=True,
                env={**os.environ, 'OUTPOST_SESSION_ID': identifier, 'OUTPOST_STATE_DIRECTORY': str(state)},
                check=True,
            )
            replies = [json.loads(line) for line in result.stdout.splitlines()]
            names = {item['name'] for item in replies[1]['result']['tools']}
            self.assertEqual(
                names,
                {'publish_file', 'search_history', 'read_context', 'read_message', 'get_session', 'refresh_index'},
                tool,
            )
            self.assertIn('untrusted', replies[0]['result']['instructions'])

    def test_appends_partial_utf8_and_replacements_preserve_or_reset_checkpoints(self):
        self.populate()
        source = next(s for s in history.catalog([])['sources'] if s['tool'] == 'codex')
        first = history.read_batch([], [{'source': source}])['files'][0]
        unchanged = history.read_batch([], [{'source': source, 'checkpoint': first['checkpoint']}])['files'][0]
        self.assertEqual(unchanged['messages'], [])
        self.assertFalse(unchanged['reset'])
        appended = (
            json.dumps(
                {
                    'type': 'response_item',
                    'payload': {'type': 'message', 'role': 'assistant', 'content': '解决缓存失效'},
                },
                ensure_ascii=False,
            ).encode()
            + b'\n'
        )
        split = appended.index('解'.encode()) + 1
        with self.codex_path.open('ab') as stream:
            stream.write(appended[:split])
        partial = history.read_batch([], [{'source': source, 'checkpoint': first['checkpoint']}])['files'][0]
        self.assertEqual(partial['checkpoint']['offset'], first['checkpoint']['offset'])
        self.assertEqual(partial['messages'], [])
        with self.codex_path.open('ab') as stream:
            stream.write(appended[split:])
        complete = history.read_batch([], [{'source': source, 'checkpoint': partial['checkpoint']}])['files'][0]
        self.assertFalse(complete['reset'])
        self.assertEqual(complete['checkpoint']['generation'], first['checkpoint']['generation'])
        self.assertEqual(complete['messages'][0]['text'], '解决缓存失效')
        self.put(
            self.codex_path,
            [
                {'type': 'session_meta', 'payload': {'id': self.codex, 'cwd': '/work/project'}},
                {'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': 'Replacement'}},
            ],
        )
        replacement = history.read_batch([], [{'source': source, 'checkpoint': complete['checkpoint']}])['files'][0]
        self.assertTrue(replacement['reset'])
        self.assertNotEqual(replacement['checkpoint']['generation'], first['checkpoint']['generation'])
        self.assertEqual(replacement['messages'][0]['text'], 'Replacement')

    def test_source_paths_are_confined_and_escaped_symlinks_are_not_read(self):
        self.populate()
        source = next(s for s in history.catalog([])['sources'] if s['tool'] == 'codex')
        secret = self.home / 'secret.jsonl'
        secret.write_text('PRIVATE_OUTSIDE_HISTORY\n')
        malicious = history.read_batch([], [{'source': {**source, 'path': str(secret)}}])
        self.assertEqual(malicious['files'], [])
        self.assertTrue(malicious['warnings'])
        self.codex_path.unlink()
        self.codex_path.symlink_to(secret)
        escaped = history.read_batch([], [{'source': source}])
        self.assertEqual(escaped['files'], [])
        self.assertNotIn('PRIVATE_OUTSIDE_HISTORY', json.dumps(escaped))

    def test_large_messages_have_online_pages_beyond_the_index_prefix(self):
        text = 'x' * (history.MAX_TEXT - 5) + '😀中文' * 8000
        self.put(
            self.codex_path,
            [
                {'type': 'session_meta', 'payload': {'id': self.codex, 'cwd': '/work'}},
                {'type': 'response_item', 'payload': {'type': 'message', 'role': 'assistant', 'content': text}},
            ],
        )
        source = history.catalog([])['sources'][0]
        file = history.read_batch([], [{'source': source}])['files'][0]
        message = file['messages'][0]
        self.assertTrue(message['truncated'])
        self.assertEqual(message['totalChars'], len(text))
        request = {
            'source': source,
            'position': message['position'],
            'contentHash': message['contentHash'],
            'offset': history.MAX_TEXT,
            'limit': 5000,
        }
        page = history.read_message([], request)
        self.assertEqual(page['text'], text[history.MAX_TEXT : history.MAX_TEXT + 5000])
        self.assertEqual(page['nextOffset'], history.MAX_TEXT + 5000)
        self.assertEqual(page['totalChars'], len(text))
        with self.assertRaisesRegex(ValueError, 'changed'):
            history.read_message([], {**request, 'contentHash': 'invalid'})

    def test_kimi_current_wire_uses_canonical_messages_without_duplicate_context_events(self):
        root = self.home / '.kimi-code/sessions/project/session_current'
        root.mkdir(parents=True)
        (root / 'state.json').write_text('{}')
        self.put(
            root / 'agents/main/wire.jsonl',
            [
                {'type': 'metadata', 'protocol_version': '1.5'},
                {
                    'type': 'agent.message.appended',
                    'time': '2026-11-11T12:00:00Z',
                    'message': {
                        'message': {'role': 'user', 'content': [{'type': 'text', 'text': 'Find the deployment bug'}]},
                        'meta': {'source': 'prompt'},
                    },
                },
                {'type': 'context.append_message', 'message': {'role': 'user', 'content': 'Find the deployment bug'}},
                {
                    'type': 'context.append_loop_event',
                    'event': {'type': 'content.part', 'part': {'type': 'text', 'text': 'The certificate expired'}},
                },
                {
                    'type': 'agent.message.appended',
                    'message': {
                        'message': {
                            'role': 'assistant',
                            'content': [{'type': 'text', 'text': 'The certificate expired'}],
                        },
                        'meta': {},
                    },
                },
            ],
        )
        source = history.catalog([])['sources'][0]
        messages = history.read_batch([], [{'source': source}])['files'][0]['messages']
        self.assertEqual([m['text'] for m in messages], ['Find the deployment bug', 'The certificate expired'])
        self.assertEqual([m['role'] for m in messages], ['user', 'assistant'])


if __name__ == '__main__':
    unittest.main()
