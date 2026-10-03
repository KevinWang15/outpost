import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

test('native turn lifecycle, unread checkpoints, bounds, and terminal input semantics', { skip: process.platform === 'win32' }, async () => {
  const result = await promisify(execFile)('python3', [fileURLToPath(new URL('./fixtures/coding-activity.py', import.meta.url))])
  assert.match(result.stderr, /Ran 11 tests/)
  assert.match(result.stderr, /OK/)
})
