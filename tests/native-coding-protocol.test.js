import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

test('native Codex fixture uses completion notifications for the requested turn and rejects its failures', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'outpost-native-protocol-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const executable = join(root, 'codex')
  await writeFile(executable, `#!/usr/bin/env python3
import json, os, sys, time
def reply(message):
    data = (json.dumps(message, ensure_ascii=False) + '\\n').encode()
    unicode = data.find('é'.encode())
    split = unicode + 1 if unicode >= 0 else len(data) // 2
    sys.stdout.buffer.write(data[:split])
    sys.stdout.buffer.flush()
    time.sleep(0.01)
    sys.stdout.buffer.write(data[split:])
    sys.stdout.buffer.flush()
for line in sys.stdin:
    request = json.loads(line)
    if 'id' not in request:
        continue
    method = request['method']
    if method == 'initialize':
        result = {'userAgent': 'fixture-é'}
    elif method == 'thread/resume':
        result = {'thread': {'id': request['params']['threadId']}}
    elif method == 'turn/start':
        def completed(turn_id, status):
            reply({'method': 'turn/completed', 'params': {'threadId': 'thread-fixture', 'turn': {'id': turn_id, 'status': status}}})
        completed('older-turn', 'interrupted')
        if os.environ['OUTPOST_FIXTURE_TIMING'] == 'before':
            completed('requested-turn', os.environ['OUTPOST_FIXTURE_FINISH'])
        result = {'turn': {'id': 'requested-turn', 'status': 'inProgress'}}
        reply({'jsonrpc': '2.0', 'id': request['id'], 'result': result})
        if os.environ['OUTPOST_FIXTURE_TIMING'] == 'after':
            completed('requested-turn', os.environ['OUTPOST_FIXTURE_FINISH'])
        continue
    else:
        raise ValueError(method)
    reply({'jsonrpc': '2.0', 'id': request['id'], 'result': result})
`, { mode: 0o700 })
  const protocol = fileURLToPath(new URL('./fixtures/native-coding-protocol.py', import.meta.url))
  const run = (status, timing) => promisify(execFile)('python3', [protocol, 'codex', executable, 'thread-fixture', root, 'turn'], {
    env: { ...process.env, OUTPOST_FIXTURE_FINISH: status, OUTPOST_FIXTURE_TIMING: timing }, timeout: 10_000,
  })
  for (const timing of ['before', 'after']) {
    assert.match((await run('completed', timing)).stdout, /NATIVE_TURN_OK thread-fixture/)
    await assert.rejects(run('failed', timing), error => /AssertionError: failed/.test(error.stderr))
  }
})
