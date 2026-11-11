"""DeepSeek native formats, compressed append/rewrite checkpoints and confinement."""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'runtime'))

import outpost_history as history
from outpost_conversations import Scan, search
from outpost_deepseek import DeepSeekAdapter


@unittest.skipUnless(shutil.which('node'), 'Node.js is required by DeepSeek Harness')
class DeepSeekTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='outpost-deepseek-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.home = self.root / '.dsh'
        self.environment = {
            'HOME': str(self.root),
            'DSH_HOME': str(self.home),
            'CODEX_HOME': str(self.root / '.codex'),
            'CLAUDE_CONFIG_DIR': str(self.root / '.claude'),
            'KIMI_CODE_HOME': str(self.root / '.kimi-code'),
        }
        patched = patch.dict(os.environ, self.environment)
        patched.start()
        self.addCleanup(patched.stop)
        self.adapter = DeepSeekAdapter()

    def records(self, identifier='native-example', version=4):
        return [
            {
                'type': 'session',
                'version': version,
                'id': identifier,
                'cwd': '/projects/deepseek',
                'createdAt': 1794380400000,
            },
            {
                'type': 'user/message',
                'seq': 0,
                'time': 1794380400000,
                'data': {
                    'role': 'user',
                    'source': {'kind': 'user'},
                    'content': [
                        {'type': 'text', 'text': 'DeepSeek fixes 缓存失效'},
                        {'type': 'image', 'data': 'IMAGE_SECRET'},
                    ],
                },
            },
            {
                'type': 'assistant/message',
                'seq': 1,
                'time': 1794380400001,
                'data': {
                    'turn': 1,
                    'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'Invalidate the cache'}]},
                    'stream': ['DUPLICATE_RAW_DELTAS'],
                },
            },
            {
                'type': 'tool/result',
                'seq': 2,
                'time': 1794380400002,
                'data': {
                    'turn': 1,
                    'message': {'role': 'tool', 'content': [{'type': 'text', 'text': 'Cache test passed'}]},
                },
            },
            {'type': 'system/message', 'seq': 3, 'data': {'message': {'content': 'SYSTEM_SECRET'}}},
            {'type': 'request/header', 'seq': 4, 'data': {'credentials': 'CREDENTIAL_SECRET'}},
            {'type': 'session/title', 'seq': 5, 'data': {'title': 'Named DeepSeek session'}},
        ]

    def encoded(self, rows):
        return b''.join(json.dumps(row, ensure_ascii=False).encode() + b'\n' for row in rows)

    def compress(self, data):
        return subprocess.check_output(
            [
                'node',
                '-e',
                'const z=require("node:zlib");process.stdin.on("data",b=>a.push(b));let a=[];process.stdin.on("end",()=>process.stdout.write(z.zstdCompressSync(Buffer.concat(a),{params:{[z.constants.ZSTD_c_checksumFlag]:1}})))',
            ],
            input=data,
        )

    def put(self, identifier='native-example', version=4, compressed=False, rows=None):
        name = 'session' + ('.v' + str(version) if version else '') + '.jsonl' + ('.zstd' if compressed else '')
        path = self.home / 'sessions' / '--projects-deepseek--' / identifier / name
        path.parent.mkdir(parents=True, exist_ok=True)
        data = self.encoded(rows if rows is not None else self.records(identifier, version))
        path.write_bytes(self.compress(data) if compressed else data)
        return path

    def test_raw_and_compressed_generations_canonical_messages_names_and_keyword_discovery(self):
        for version in range(5):
            self.put('native-' + str(version), version, compressed=bool(version % 2))
        self.put('native-4', 3)  # retained generation must not be indexed twice
        sources = history.catalog([])['sources']
        self.assertEqual(len(sources), 5)
        self.assertEqual({source['tool'] for source in sources}, {'deepseek'})
        self.assertTrue(all(source['title'] == 'Named DeepSeek session' for source in sources))
        batch = history.read_batch([], [{'source': source} for source in sources])
        self.assertEqual(batch['warnings'], [])
        messages = [entry for file in batch['files'] for entry in file['messages']]
        self.assertEqual(len(messages), 15)
        self.assertEqual({entry['role'] for entry in messages}, {'user', 'assistant', 'tool'})
        for forbidden in ['SYSTEM_SECRET', 'CREDENTIAL_SECRET', 'IMAGE_SECRET', 'DUPLICATE_RAW_DELTAS']:
            self.assertNotIn(forbidden, json.dumps(messages))
        found = search('缓存', tool='deepseek')
        self.assertEqual(len(found['sessions']), 5)
        self.assertEqual(found['warnings'], [])

    def test_compressed_appends_preserve_cursors_and_rewrites_reset_them(self):
        path = self.put(compressed=True)
        source = history.catalog([])['sources'][0]
        original = path.read_bytes()
        first = history.read_batch([], [{'source': source}])['files'][0]
        unchanged = history.read_batch([], [{'source': source, 'checkpoint': first['checkpoint']}])['files'][0]
        self.assertEqual(unchanged['messages'], [])
        self.assertFalse(unchanged['reset'])
        extra = {'type': 'assistant/message', 'data': {'message': {'content': 'Additional result'}}}
        frame = self.compress(self.encoded([extra]))
        with path.open('ab') as stream:
            stream.write(frame[: len(frame) // 2])
        torn = history.read_batch([], [{'source': source, 'checkpoint': first['checkpoint']}])['files'][0]
        self.assertEqual(torn['messages'], [])
        self.assertFalse(torn['reset'])
        self.assertEqual(torn['checkpoint']['generation'], first['checkpoint']['generation'])
        with path.open('ab') as stream:
            stream.write(frame[len(frame) // 2 :])
        appended = history.read_batch([], [{'source': source, 'checkpoint': first['checkpoint']}])['files'][0]
        self.assertFalse(appended['reset'])
        self.assertEqual(appended['checkpoint']['generation'], first['checkpoint']['generation'])
        self.assertEqual([message['text'] for message in appended['messages']], ['Additional result'])
        path.write_bytes(original)
        rewritten = history.read_batch([], [{'source': source, 'checkpoint': appended['checkpoint']}])['files'][0]
        self.assertTrue(rewritten['reset'])
        self.assertNotEqual(rewritten['checkpoint']['generation'], appended['checkpoint']['generation'])

    def test_read_message_compressed_unicode_paging_and_native_files_are_unchanged(self):
        rows = self.records()
        text = '缓存🚀' * 350000
        rows.append({'type': 'assistant/message', 'data': {'message': {'content': text}}})
        path = self.put(compressed=True, rows=rows)
        before = hashlib.sha256(path.read_bytes()).hexdigest()
        source = history.catalog([])['sources'][0]
        batch = history.read_batch([], [{'source': source}])
        entry = batch['files'][0]['messages'][-1]
        self.assertTrue(entry['truncated'])
        page = history.read_message(
            [],
            {
                'source': source,
                'position': entry['position'],
                'contentHash': entry['contentHash'],
                'offset': 1048576,
                'limit': 100,
            },
        )
        self.assertEqual(page['text'], text[1048576:1048676])
        self.assertEqual(before, hashlib.sha256(path.read_bytes()).hexdigest())

    def test_subagents_are_searchable_but_not_resumable_and_symlinks_are_rejected(self):
        rows = self.records('child')
        rows[0]['origin'] = 'subagent'
        child = self.put('child', rows=rows)
        self.assertEqual(len(history.catalog([])['sources']), 1)
        self.assertEqual(list(self.adapter.discover(self.environment, Scan())), [])
        outside = self.root / 'private.jsonl'
        outside.write_bytes(child.read_bytes())
        child.unlink()
        child.symlink_to(outside)
        catalog = history.catalog([])
        self.assertEqual(catalog['sources'], [])
        self.assertTrue(catalog['warnings'])

    def test_native_activity_comes_from_lifecycle_events(self):
        self.assertEqual(
            self.adapter.activity_event({'type': 'turn/start', 'time': 1, 'data': {'turn': 2}}).state, 'working'
        )
        self.assertEqual(
            self.adapter.activity_event({'type': 'approval/asked', 'time': 2, 'data': {}}).state, 'waiting'
        )
        self.assertEqual(
            self.adapter.activity_event(
                {'type': 'turn/end', 'time': 3, 'data': {'turn': 2, 'reason': {'kind': 'completed'}}}
            ).state,
            'finished',
        )
        self.assertIsNone(self.adapter.activity_event({'type': 'assistant/message', 'data': {}}))

    def test_checksum_corruption_and_future_formats_are_reported_without_hiding_healthy_sessions(self):
        healthy = self.put('healthy', compressed=True)
        broken = self.put('broken', compressed=True)
        data = broken.read_bytes()
        broken.write_bytes(data[:-1] + bytes([data[-1] ^ 255]))
        self.put('future', version=5)
        result = history.catalog([])
        self.assertEqual([source['nativeId'] for source in result['sources']], ['healthy'])
        self.assertTrue(result['warnings'])
        self.assertTrue(healthy.is_file())
