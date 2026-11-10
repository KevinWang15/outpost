import assert from 'node:assert/strict'
import test from 'node:test'
import type * as acp from '@agentclientprotocol/sdk'
import { ChatJournal, journalBlock, type ChatEntryInput } from '../../shared/chatHost'
import { promptHeader, replyText, transcript } from '../../shared/chatTranscript'

const chunk = (text: string, messageId = 'm1'): acp.SessionUpdate => ({
  sessionUpdate: 'agent_message_chunk',
  messageId,
  content: { type: 'text', text },
})

/** The host records; a viewer applies the same broadcast entries in order. */
function replay(inputs: ChatEntryInput[], limits?: { entries: number; bytes: number }) {
  const host = new ChatJournal(limits)
  const viewer = new ChatJournal(limits)
  for (const input of inputs) assert.equal(viewer.accept(structuredClone(host.record(input))), true)
  return { host, viewer }
}

test('chat journal: streamed text merges into one entry, identically on host and viewer', () => {
  const { host, viewer } = replay([
    { kind: 'queued', turn: 't1', key: null, origin: { kind: 'user' }, prompt: [{ type: 'text', text: 'Hi' }] },
    { kind: 'started', turn: 't1' },
    { kind: 'update', turn: 't1', update: chunk('Hel') },
    { kind: 'update', turn: 't1', update: chunk('lo') },
    { kind: 'update', turn: 't1', update: chunk(' again', 'm2') },
    { kind: 'ended', turn: 't1', stopReason: 'end_turn', error: null },
  ])
  assert.deepEqual(viewer.entries, host.entries)
  assert.equal(host.lastSeq, 6)
  const texts = host.entries.flatMap(entry =>
    entry.kind === 'update' &&
    entry.update.sessionUpdate === 'agent_message_chunk' &&
    entry.update.content.type === 'text'
      ? [entry.update.content.text]
      : [],
  )
  assert.deepEqual(texts, ['Hello', ' again'])
  assert.equal(replyText(host.entries, 't1'), 'again')
})

test('chat journal: tool reports and streamed command output merge into their tool call', () => {
  const output = (data: string): acp.SessionUpdate => ({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'x',
    _meta: { terminal_output_delta: { terminal_id: 'x', data } },
  })
  const { host, viewer } = replay([
    { kind: 'started', turn: 't1' },
    {
      kind: 'update',
      turn: 't1',
      update: { sessionUpdate: 'tool_call', toolCallId: 'x', title: 'Run tests', status: 'pending' },
    },
    { kind: 'update', turn: 't1', update: output('one\n') },
    { kind: 'update', turn: 't1', update: output('two\n') },
    { kind: 'update', turn: 't1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'completed' } },
  ])
  assert.deepEqual(viewer.entries, host.entries)
  assert.equal(host.entries.length, 2)
  const view = transcript(host.entries)
  const tool = view.turns[0].items[0]
  assert.equal(tool.type, 'tool')
  assert.equal(tool.type === 'tool' && tool.status, 'completed')
  assert.equal(tool.type === 'tool' && tool.title, 'Run tests')
  assert.equal(tool.type === 'tool' && tool.terminal, 'one\ntwo\n')
})

test('chat journal: viewers detect gaps, and old entries are dropped like scrollback', () => {
  const journal = new ChatJournal()
  const host = new ChatJournal()
  host.record({ kind: 'started', turn: 't1' })
  const second = host.record({ kind: 'ended', turn: 't1', stopReason: 'end_turn', error: null })
  assert.equal(journal.accept(second), false)

  const { host: small } = replay(
    Array.from(
      { length: 10 },
      (_, index) => ({ kind: 'notice', level: 'info', turn: null, text: `n${index}` }) as const,
    ),
    { entries: 4, bytes: 1024 * 1024 },
  )
  assert.equal(small.entries.length, 4)
  assert.equal(small.truncated, true)
  assert.equal(small.entries[0].seq, 7)
})

test('chat transcript: live turns, permissions, queue and replayed history', () => {
  const header = `${promptHeader('#release')}New messages`
  const { host } = replay([
    { kind: 'history', phase: 'begin' },
    {
      kind: 'update',
      turn: null,
      update: { sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'Earlier' } },
    },
    { kind: 'update', turn: null, update: chunk('Earlier reply', 'a1') },
    {
      kind: 'update',
      turn: null,
      update: { sessionUpdate: 'user_message_chunk', messageId: 'u2', content: { type: 'text', text: header } },
    },
    { kind: 'update', turn: null, update: chunk('Channel reply', 'a2') },
    { kind: 'history', phase: 'end' },
    { kind: 'queued', turn: 't1', key: 'k', origin: { kind: 'user' }, prompt: [{ type: 'text', text: 'Now' }] },
    { kind: 'started', turn: 't1' },
    {
      kind: 'permission',
      turn: 't1',
      id: 'p1',
      toolCall: { toolCallId: 'x', title: 'Write file' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    },
    { kind: 'queued', turn: 't2', key: null, origin: { kind: 'user' }, prompt: [{ type: 'text', text: 'Next' }] },
  ])
  let view = transcript(host.entries)
  assert.deepEqual(
    view.turns.map(turn => [turn.status, turn.label]),
    [
      ['history', null],
      ['history', '#release'],
      ['running', null],
      ['queued', null],
    ],
  )
  assert.equal(view.running?.id, 't1')
  assert.deepEqual(
    view.queue.map(turn => turn.id),
    ['t2'],
  )
  assert.equal(view.pending.length, 1)
  host.record({ kind: 'resolved', turn: 't1', id: 'p1', optionId: 'allow' })
  view = transcript(host.entries)
  assert.equal(view.pending.length, 0)
})

test('chat journal: prompts keep image metadata without bytes', () => {
  const block = journalBlock({ type: 'image', mimeType: 'image/png', data: 'A'.repeat(1000) })
  assert.equal(block.type === 'image' && block.data, '')
  assert.deepEqual(block._meta, { outpost: { omittedBytes: 1000 } })
})
