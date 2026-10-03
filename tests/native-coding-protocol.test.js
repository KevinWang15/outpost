import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

test('native Codex fixture waits for the requested turn and still rejects its failures', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'outpost-native-protocol-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const executable = join(root, 'codex')
  await writeFile(executable, `#!/usr/bin/env python3
import json, os, sys
reads = 0
for line in sys.stdin:
    request = json.loads(line)
    if 'id' not in request:
        continue
    method = request['method']
    if method == 'initialize':
        result = {}
    elif method == 'thread/resume':
        result = {'thread': {'id': request['params']['threadId']}}
    elif method == 'turn/start':
        result = {'turn': {'id': 'requested-turn', 'status': 'inProgress'}}
    elif method == 'thread/read':
        reads += 1
        turns = [{'id': 'older-turn', 'status': 'interrupted'}]
        if reads > 1:
            turns.insert(0, {'id': 'requested-turn', 'status': 'inProgress' if reads == 2 else os.environ['OUTPOST_FIXTURE_FINISH']})
        result = {'thread': {'turns': turns}}
    else:
        raise ValueError(method)
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)
`, { mode: 0o700 })
  const protocol = fileURLToPath(new URL('./fixtures/native-coding-protocol.py', import.meta.url))
  const run = status => promisify(execFile)('python3', [protocol, 'codex', executable, 'thread-fixture', root, 'turn'], {
    env: { ...process.env, OUTPOST_FIXTURE_FINISH: status }, timeout: 10_000,
  })
  assert.match((await run('completed')).stdout, /NATIVE_TURN_OK thread-fixture/)
  await assert.rejects(run('failed'), error => /AssertionError: failed/.test(error.stderr))
})
