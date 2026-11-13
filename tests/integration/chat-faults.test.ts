// Message passing under failures: every message ends delivered exactly once,
// or failed with a visible notice. Never lost silently, never run twice.
import assert from 'node:assert/strict'
import test from 'node:test'
import { chatHarness, pause, until } from './chat-harness'

test('a lost answer to a delivery does not orphan its turn', async () => {
  const chat = await chatHarness(['Coder'])
  try {
    const hub = await chat.startHub({ promptMs: 1500 })
    const [coder] = chat.sessions
    const channel = await hub.saveChannel(chat.owner, { name: 'lost', topic: '', members: [chat.ref(coder)] })
    const link = await hub.link(chat.owner, chat.ref(coder))
    link.ensure(true)
    await until(() => link.state === 'live' && link.info?.state === 'ready', 'a ready chat')
    // The host receives the prompt and runs it, but its answer never comes back.
    chat.muted.add(coder.id)
    await hub.post(chat.owner, channel.id, 'p1', '@coder slow 2 check')
    await pause(2000)
    chat.muted.delete(coder.id)
    const reply = await until(
      () => chat.messages().find(message => message.author.kind === 'session'),
      'the reply',
      20_000,
    )
    assert.match(reply.text, /Fixture reply/)
    await pause(500)
    assert.equal(chat.messages().filter(message => message.author.kind === 'session').length, 1)
    assert.equal(chat.turns(coder), 1)
  } finally {
    await chat.close()
  }
})

test('a server restart while a member works still posts its reply', async () => {
  const chat = await chatHarness(['Coder'])
  try {
    const first = await chat.startHub()
    const [coder] = chat.sessions
    const channel = await first.saveChannel(chat.owner, { name: 'restart', topic: '', members: [chat.ref(coder)] })
    await first.post(chat.owner, channel.id, 'p1', '@coder slow 2 check')
    await until(() => chat.deliveries().find(item => item.state === 'running'), 'a running delivery')
    first.close()
    chat.received.length = 0
    await chat.startHub()
    const reply = await until(
      () => chat.messages().find(message => message.author.kind === 'session'),
      'the reply after restart',
    )
    assert.match(reply.text, /Fixture reply/)
    assert.equal(chat.turns(coder), 1)
  } finally {
    await chat.close()
  }
})

test('a server restart before a prompt is confirmed settles it without running it twice', async () => {
  const chat = await chatHarness(['Coder'])
  try {
    const first = await chat.startHub({ promptMs: 60_000 })
    const [coder] = chat.sessions
    const channel = await first.saveChannel(chat.owner, { name: 'unconfirmed', topic: '', members: [chat.ref(coder)] })
    const link = await first.link(chat.owner, chat.ref(coder))
    link.ensure(true)
    await until(() => link.state === 'live' && link.info?.state === 'ready', 'a ready chat')
    chat.muted.add(coder.id)
    await first.post(chat.owner, channel.id, 'p1', '@coder slow 1 check')
    await until(() => chat.turns(coder) === 1, 'the turn on the host')
    first.close()
    chat.muted.delete(coder.id)
    chat.received.length = 0
    await chat.startHub()
    const reply = await until(
      () => chat.messages().find(message => message.author.kind === 'session'),
      'the reply after restart',
    )
    assert.match(reply.text, /Fixture reply/)
    await pause(500)
    assert.equal(chat.turns(coder), 1)
  } finally {
    await chat.close()
  }
})

test('an agent can message a session while the server reconnects', async () => {
  const chat = await chatHarness(['Coder', 'Reviewer'])
  try {
    const first = await chat.startHub()
    const [coder, reviewer] = chat.sessions
    const link = await first.link(chat.owner, chat.ref(coder))
    link.ensure(true)
    await until(() => link.state === 'live' && link.info?.state === 'ready', 'a ready chat')
    // The agent calls message_session two seconds in; the server restarts meanwhile.
    await link.request({
      type: 'prompt',
      key: 'k1',
      origin: { kind: 'user' },
      prompt: [{ type: 'text', text: 'slow 2 message reviewer: please review' }],
      files: [],
    })
    first.close()
    chat.received.length = 0
    await chat.startHub()
    const delivered = await until(
      () => chat.deliveries().find(item => item.sessionId === reviewer.id && item.state === 'done'),
      "the reviewer's delivery",
      30_000,
    )
    assert.equal(delivered.source.kind, 'session')
    assert.equal(chat.deliveries().filter(item => item.sessionId === reviewer.id).length, 1)
  } finally {
    await chat.close()
  }
})

test('a session message survives a connection lost before the agent got its answer', async () => {
  const chat = await chatHarness(['Coder', 'Reviewer'])
  try {
    const hub = await chat.startHub()
    const [coder, reviewer] = chat.sessions
    const link = await hub.link(chat.owner, chat.ref(coder))
    link.ensure(true)
    await until(() => link.state === 'live' && link.info?.state === 'ready', 'a ready chat')
    chat.breakOnAnswer.add(coder.id)
    const result = await link.request({
      type: 'prompt',
      key: 'k1',
      origin: { kind: 'user' },
      prompt: [{ type: 'text', text: 'message reviewer: please review' }],
      files: [],
    })
    assert.equal(result.ok, true)
    const turn = (result.data as { turn: string }).turn
    await until(
      () => chat.hosts.get(coder.id)?.journal.entries.some(entry => entry.kind === 'ended' && entry.turn === turn),
      "the coder's turn",
      30_000,
    )
    const reply = chat.hosts
      .get(coder.id)!
      .journal.entries.filter(entry => entry.kind === 'update' && entry.turn === turn)
      .map(entry =>
        entry.kind === 'update' &&
        entry.update.sessionUpdate === 'agent_message_chunk' &&
        entry.update.content.type === 'text'
          ? entry.update.content.text
          : '',
      )
      .join('')
    // The agent was told the message was sent, and the reviewer received it once.
    assert.match(reply, /"sent": true/)
    await until(() => chat.deliveries().find(item => item.sessionId === reviewer.id), "the reviewer's delivery")
    await pause(1000)
    assert.equal(chat.deliveries().filter(item => item.sessionId === reviewer.id).length, 1)
  } finally {
    await chat.close()
  }
})

test('a coding tool that crashes mid-turn ends its delivery with a notice', async () => {
  const chat = await chatHarness(['Coder'])
  try {
    const hub = await chat.startHub()
    const [coder] = chat.sessions
    const channel = await hub.saveChannel(chat.owner, { name: 'crash', topic: '', members: [chat.ref(coder)] })
    await hub.post(chat.owner, channel.id, 'p1', '@coder crash now')
    const notice = await until(() => chat.messages().find(message => message.author.kind === 'outpost'), 'a notice')
    assert.match(notice.text, /@coder failed: The coding tool closed its connection/)
    assert.equal(chat.deliveries()[0].state, 'done')
    assert.match(chat.deliveries()[0].error ?? '', /closed its connection/)
  } finally {
    await chat.close()
  }
})

test('a prompt whose connection ends before it is confirmed runs once', async () => {
  const chat = await chatHarness(['Coder'])
  try {
    const hub = await chat.startHub()
    const [coder] = chat.sessions
    const channel = await hub.saveChannel(chat.owner, { name: 'cut', topic: '', members: [chat.ref(coder)] })
    const link = await hub.link(chat.owner, chat.ref(coder))
    link.ensure(true)
    await until(() => link.state === 'live' && link.info?.state === 'ready', 'a ready chat')
    chat.cutAfterPrompt.add(coder.id)
    await hub.post(chat.owner, channel.id, 'p1', '@coder check')
    const reply = await until(() => chat.messages().find(message => message.author.kind === 'session'), 'the reply')
    assert.match(reply.text, /Fixture reply/)
    await pause(500)
    assert.equal(chat.turns(coder), 1)
  } finally {
    await chat.close()
  }
})

test('a chat host that stops while a prompt is unconfirmed settles it with a notice', async () => {
  const chat = await chatHarness(['Coder'])
  try {
    const hub = await chat.startHub({ promptMs: 60_000 })
    const [coder] = chat.sessions
    const channel = await hub.saveChannel(chat.owner, { name: 'stopped', topic: '', members: [chat.ref(coder)] })
    const link = await hub.link(chat.owner, chat.ref(coder))
    link.ensure(true)
    await until(() => link.state === 'live' && link.info?.state === 'ready', 'a ready chat')
    chat.muted.add(coder.id)
    await hub.post(chat.owner, channel.id, 'p1', '@coder slow 5 check')
    await until(() => chat.turns(coder) === 1, 'the turn on the host')
    chat.hosts.get(coder.id)!.stop()
    // The journal named the turn, so the hub knows it was cancelled rather than guessing.
    const notice = await until(() => chat.messages().find(message => message.author.kind === 'outpost'), 'a notice')
    assert.match(notice.text, /@coder stopped without replying/)
    assert.equal(chat.deliveries()[0].state, 'done')
  } finally {
    await chat.close()
  }
})

test('a connection that goes silent is replaced; the chat host keeps running', async () => {
  const chat = await chatHarness(['Coder'])
  try {
    const hub = await chat.startHub({ probeMs: 600 })
    const [coder] = chat.sessions
    const link = await hub.link(chat.owner, chat.ref(coder))
    link.subscribe(() => {}) // A viewer, so the link reconnects.
    link.ensure(true)
    await until(() => link.state === 'live' && link.info?.state === 'ready', 'a ready chat')
    const instance = link.instance
    // The stream stops carrying anything, as with a hung SSH connection.
    chat.frozen.add(coder.id)
    await until(() => link.state !== 'live', 'the silent link to be replaced', 5000)
    chat.frozen.delete(coder.id)
    await until(() => link.state === 'live', 'the new connection', 10_000)
    assert.equal(link.instance, instance)
  } finally {
    await chat.close()
  }
})

test('a channel post resent after a server restart is posted once', async () => {
  const chat = await chatHarness(['Coder'])
  try {
    const first = await chat.startHub()
    const [coder] = chat.sessions
    const channel = await first.saveChannel(chat.owner, { name: 'resend', topic: '', members: [chat.ref(coder)] })
    const posted = await first.post(chat.owner, channel.id, 'draft1', 'hello, nobody mentioned')
    first.close()
    const second = await chat.startHub()
    const again = await second.post(chat.owner, channel.id, 'draft1', 'hello, nobody mentioned')
    assert.deepEqual(again, { messageId: posted.messageId, duplicate: true })
    const { messages } = await second.history(chat.owner, channel.id, null)
    assert.equal(messages.filter(message => message.author.kind === 'user').length, 1)
  } finally {
    await chat.close()
  }
})
