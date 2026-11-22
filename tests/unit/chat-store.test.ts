import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ChatStore } from '../../backend/chat/store'
import type { ChannelMessage, Delivery } from '../../shared/chatApi'

const message = (channelId: string): ChannelMessage => ({
  id: crypto.randomUUID(),
  channelId,
  at: new Date().toISOString(),
  author: { kind: 'user' },
  text: 'Hello',
  mentions: [],
  root: crypto.randomUUID(),
  hop: 0,
  turn: null,
  key: null,
  files: [],
})
const delivery = (): Delivery => ({
  id: crypto.randomUUID(),
  targetId: 'work',
  sessionId: crypto.randomUUID(),
  state: 'pending',
  turn: null,
  source: { kind: 'schedule', scheduleId: crypto.randomUUID() },
  rerun: null,
  prompt: 'Hello',
  files: [],
  host: null,
  via: null,
  origin: { kind: 'schedule', scheduleId: crypto.randomUUID(), name: 'Daily' },
  error: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
})

test('chat state rejects incomplete or surplus delivery fields on reads and writes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-chat-store-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'deliveries.json')
  for (const field of ['files', 'via']) {
    const row = delivery()
    Reflect.deleteProperty(row, field)
    const bytes = JSON.stringify({ version: 1, deliveries: [row] })
    await writeFile(path, bytes)
    await assert.rejects(new ChatStore(directory).load(), /current schema/)
    assert.equal(await readFile(path, 'utf8'), bytes)
  }
  const current = delivery()
  const saved = JSON.stringify({ version: 1, deliveries: [current] })
  await writeFile(path, saved)
  const store = new ChatStore(directory)
  await assert.rejects(
    store.change(['deliveries'], () => {
      store.deliveries.deliveries.push(Object.assign(delivery(), { handle: 'unexpected' }))
    }),
    /Cannot save invalid/,
  )
  assert.equal(await readFile(path, 'utf8'), saved)
  assert.deepEqual(store.deliveries.deliveries, [current])
})

test('malformed channel logs prevent append and preserve each original record', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-chat-messages-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const channelId = crypto.randomUUID(),
    row = message(channelId),
    path = join(directory, 'messages', `${channelId}.jsonl`)
  await mkdir(join(directory, 'messages'))
  const line = `${JSON.stringify(row)}\n`
  const stale = { ...row }
  Reflect.deleteProperty(stale, 'files')
  for (const bytes of [line + '{', line + '{}\n' + line, line + 'invalid\n', JSON.stringify(stale) + '\n']) {
    await writeFile(path, bytes)
    await assert.rejects(new ChatStore(directory).append(message(channelId)), /record/)
    assert.equal(await readFile(path, 'utf8'), bytes)
  }
  await writeFile(path, line)
  const next = message(channelId)
  await new ChatStore(directory).append(next)
  assert.deepEqual(await new ChatStore(directory).recent(channelId), [row, next])
})
