import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatLink, type ChatTransportEvents } from '../../backend/chat/links'
import { chatHost, type ChatHostMessage, type ChatInfo } from '../../shared/chatHost'

test('a chat stream checks the protocol before it accepts a snapshot or sends queued requests', async t => {
  for (const first of [{ type: 'welcome' }, { type: 'welcome', protocol: chatHost.protocol - 1 }, { type: 'entry' }]) {
    let stream!: ChatTransportEvents
    const sent: string[] = []
    const link = new ChatLink(
      'test',
      (_, events) => {
        stream = events
        return { send: frame => sent.push(frame.type), close: () => events.closed('Closed', null) }
      },
      { changed() {}, disposed() {} },
    )
    t.after(() => link.dispose())
    link.ensure(true)
    const queued = link.request({ type: 'cancel' })
    stream.message(first as ChatHostMessage)
    assert.deepEqual(sent, ['hello'])
    assert.equal(link.state, 'unavailable')
    assert.match((await queued).message!, /Invalid chat handshake/)
    assert.equal(link.instance, null)
  }
})

test('a terminal-backed chat can replace the journal on an established current-protocol stream', t => {
  let stream!: ChatTransportEvents
  const link = new ChatLink(
    'test',
    (_, events) => {
      stream = events
      return { send() {}, close() {} }
    },
    { changed() {}, disposed() {} },
  )
  t.after(() => link.dispose())
  link.ensure(true)
  const welcome = {
    type: 'welcome' as const,
    protocol: chatHost.protocol,
    instance: 'host',
    info: { state: 'ready', activity: { state: 'idle' } } as ChatInfo,
  }
  for (const lastSeq of [1, 2]) stream.message({ ...welcome, journal: { lastSeq, entries: [], truncated: false } })
  assert.equal(link.state, 'live')
  assert.equal(link.journal.lastSeq, 2)
  stream.message({
    ...welcome,
    protocol: chatHost.protocol - 1,
    journal: { lastSeq: 3, entries: [], truncated: false },
  })
  assert.equal(link.state, 'unavailable')
  assert.equal(link.journal.lastSeq, 2)
})
