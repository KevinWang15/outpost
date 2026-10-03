import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionClient } from '../backend/sessions.ts'
import { maxImageBytes } from '../shared/session-manager.ts'

const target = { kind: 'ssh', id: 'images', name: 'Images', host: 'dev.example.com', backends: ['tmux'], tools: ['codex'], createdAt: '2026-09-30T00:00:00Z' }

test('image validation rejects malformed base64 and oversized bytes before contacting a target', async () => {
  const service = new SessionClient()
  for (const image of [
    { data: 'aGVsbG8=', mediaType: 'text/plain' },
    ...['', '%%%%invalid', 'aGVsbG8', 'aGVsbG8===', 'aGVsbG8=\n', 'aGVsbG9='].map(data => ({ data, mediaType: 'image/png' })),
  ]) await assert.rejects(service.pasteImage(target, 'session', image), error => error.statusCode === 400)
  // One extra byte can have the same encoded length as the largest allowed image.
  for (const size of [maxImageBytes + 1, maxImageBytes + 4]) {
    await assert.rejects(service.pasteImage(target, 'session', { data: Buffer.alloc(size).toString('base64'), mediaType: 'image/png' }), error => error.statusCode === 413)
  }
})
