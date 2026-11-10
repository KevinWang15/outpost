// The chat hub with real chat hosts and the scripted ACP agent (chat-harness.ts).
import assert from 'node:assert/strict'
import test from 'node:test'
import { chatHarness, pause, until } from './chat-harness'

test('chat hub: channels pass the floor, sessions message each other, schedules fire', async () => {
  const chat = await chatHarness(['Coder', 'Writer', 'Reviewer'])
  try {
    const hub = await chat.startHub()
    const [coder, writer, reviewer] = chat.sessions
    const { owner } = chat
    const listed = chat.received.flatMap(message => (message.type === 'sessions' ? [message.sessions] : [])).at(-1)
    assert.deepEqual(
      listed?.map(item => item.handle),
      ['coder', 'writer', 'reviewer'],
    )
    const channel = await hub.saveChannel(owner, {
      name: 'release',
      topic: 'Ship 1.2',
      members: [chat.ref(coder), chat.ref(writer)],
    })

    // A user message reaches only the member it mentions; its reply comes back.
    await hub.post(owner, channel.id, 'post1', '@coder check the build')
    const reply = await until(
      () => chat.messages().find(message => message.author.kind === 'session' && message.author.handle === 'coder'),
      'the coder reply',
    )
    assert.match(reply.text, /^Fixture reply to: You are coder in the Outpost channel #release \(Ship 1\.2\)/)
    assert.deepEqual(reply.mentions, [])
    assert.equal(reply.hop, 1)
    assert.ok(reply.turn)
    assert.equal(chat.deliveries().filter(item => item.sessionId === writer.id).length, 0)
    // The same post key is one post.
    assert.equal((await hub.post(owner, channel.id, 'post1', '@coder check the build')).duplicate, true)

    // Members that keep passing the floor are stopped after the hop limit.
    await hub.post(owner, channel.id, 'post2', '@coder pass the floor')
    const stopped = await until(
      () => chat.messages().find(message => message.author.kind === 'outpost' && /stopped passing/.test(message.text)),
      'the floor limit',
      60_000,
    )
    const chain = chat.messages().filter(message => message.root === stopped.root && message.author.kind === 'session')
    assert.equal(chain.at(-1)!.hop, 6)
    assert.deepEqual(
      chain.slice(0, 3).map(message => (message.author.kind === 'session' ? message.author.handle : '')),
      ['coder', 'writer', 'coder'],
    )

    // Session-to-session: the reviewer replies, and the reply returns to the coder.
    const coderLink = await hub.link(owner, chat.ref(coder))
    coderLink.ensure(true)
    await until(() => coderLink.state === 'live', 'the coder link')
    const sent = await coderLink.request({
      type: 'prompt',
      key: 'ask-reviewer',
      origin: { kind: 'user' },
      prompt: [{ type: 'text', text: 'message @reviewer: please review the release notes' }],
    })
    assert.equal(sent.ok, true, sent.message)
    const back = await until(
      () =>
        chat
          .deliveries()
          .find(
            item =>
              item.sessionId === coder.id &&
              item.source.kind === 'session' &&
              item.source.reply &&
              item.state === 'done',
          ),
      'the reply delivery',
      60_000,
    )
    assert.equal(back.source.kind === 'session' && back.source.from.sessionId, reviewer.id)
    const reviewerTurn = chat
      .deliveries()
      .find(item => item.sessionId === reviewer.id && item.source.kind === 'session')!
    assert.equal(reviewerTurn.state, 'done')

    // A schedule fires into the session's own chat and records its run.
    const schedule = await hub.saveSchedule(owner, {
      name: 'Morning check',
      ...chat.ref(writer),
      prompt: 'Summarize overnight changes',
      cron: '0 9 * * 1-5',
      timeZone: 'UTC',
      enabled: true,
    })
    await hub.runSchedule(owner, schedule.id)
    const ran = await until(
      () =>
        chat.received.flatMap(message =>
          message.type === 'schedule' && message.schedule.lastRun ? [message.schedule] : [],
        )[0],
      'the schedule run',
    )
    assert.equal(ran.lastRun!.ok, true)
    await assert.rejects(hub.saveSchedule(owner, { ...schedule, cron: '61 * * * *' }), /Invalid minute/)
  } finally {
    await chat.close()
  }
})

test('a chat host with no viewers and nothing to do stops; one with a viewer keeps running', async () => {
  const chat = await chatHarness(['Coder'], { idleMs: 400 })
  try {
    const hub = await chat.startHub()
    const [coder] = chat.sessions
    const link = await hub.link(chat.owner, chat.ref(coder))
    link.ensure(true)
    await until(() => link.state === 'live' && link.info?.state === 'ready', 'a ready chat')
    await pause(1000)
    assert.ok(chat.hosts.has(coder.id), 'a connected host keeps running')
    link.dispose()
    await until(() => !chat.hosts.has(coder.id), 'the idle host to stop', 5000)
  } finally {
    await chat.close()
  }
})
