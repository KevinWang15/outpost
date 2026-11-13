// The chat hub with real chat hosts and the scripted ACP agent (chat-harness.ts).
import assert from 'node:assert/strict'
import test from 'node:test'
import { chatLimits } from '../../shared/chatApi'
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
    assert.match(
      reply.text,
      /^Fixture reply to: the user: coder check the build\n\nYou are coder in the Outpost channel #release \(Ship 1\.2\)/,
    )
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
      files: [],
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

test('a file the agent publishes appears in its turn and in its channel reply', async () => {
  const chat = await chatHarness(['Coder'])
  try {
    const hub = await chat.startHub()
    const [coder] = chat.sessions
    const channel = await hub.saveChannel(chat.owner, { name: 'files', topic: '', members: [chat.ref(coder)] })
    await hub.post(chat.owner, channel.id, 'p1', '@coder publish report.txt')
    const reply = await until(
      () => chat.messages().find(message => message.author.kind === 'session'),
      'the reply with its file',
    )
    assert.deepEqual(
      reply.files.map(file => [file.name, file.size]),
      [['report.txt', 'Fixture file report.txt\n'.length]],
    )
    // The session's own transcript has the file in the turn that published it.
    const entry = chat.hosts.get(coder.id)!.journal.entries.find(item => item.kind === 'file')
    assert.ok(entry?.kind === 'file' && entry.turn === reply.turn?.turn && entry.file.id === reply.files[0].id)
  } finally {
    await chat.close()
  }
})

test('files the user attaches reach the agent as links it can read, in its session and through a channel', async () => {
  const chat = await chatHarness(['Coder', 'Writer'])
  try {
    const hub = await chat.startHub()
    const [coder, writer] = chat.sessions
    const { owner } = chat

    // A session's own chat: the file is already in its files; the prompt links it.
    const notes = await chat.files.receive(null, coder.id, 'notes v2.txt', Buffer.from('Ship on Friday\n'))
    assert.equal(notes.source, 'received')
    const link = await hub.link(owner, chat.ref(coder))
    link.ensure(true)
    await until(() => link.state === 'live', 'the coder link')
    const sent = await link.request({
      type: 'prompt',
      key: 'with-file',
      origin: { kind: 'user' },
      prompt: [{ type: 'text', text: 'summarize' }],
      files: [notes.id],
    })
    assert.equal(sent.ok, true, sent.message)
    const turn = (sent.data as { turn: string }).turn
    const queued = link.journal.entries.find(entry => entry.kind === 'queued' && entry.turn === turn)
    const block = queued?.kind === 'queued' ? queued.prompt.find(item => item.type === 'resource_link') : undefined
    assert.ok(block?.type === 'resource_link' && block.name === 'notes v2.txt' && block.uri.startsWith('file:///'))
    const text = () =>
      link.journal.entries
        .flatMap(entry =>
          entry.kind === 'update' &&
          entry.turn === turn &&
          entry.update.sessionUpdate === 'agent_message_chunk' &&
          entry.update.content.type === 'text'
            ? [entry.update.content.text]
            : [],
        )
        .join('')
    await until(() => text().includes('(read notes v2.txt: Ship on Friday)'), 'the agent reading the file')
    const missing = await link.request({
      type: 'prompt',
      key: 'missing-file',
      origin: { kind: 'user' },
      prompt: [{ type: 'text', text: 'summarize' }],
      files: ['0'.repeat(32)],
    })
    assert.equal(missing.ok, false)
    assert.match(missing.message ?? '', /no longer in this session/)

    // A channel post: the upload is kept with the channel, then copied into the
    // mentioned member's own files and linked in its prompt.
    const channel = await hub.saveChannel(owner, {
      name: 'docs',
      topic: '',
      members: [chat.ref(coder), chat.ref(writer)],
    })
    const brief = await hub.stageFile(owner, channel.id, 'brief.md', Buffer.from('# Launch brief\n'))
    await hub.post(owner, channel.id, 'post-brief', '@writer read this', [brief.id])
    const post = chat.messages().find(message => message.key === 'post-brief')!
    assert.deepEqual(
      post.files.map(file => file.name),
      ['brief.md'],
    )
    assert.deepEqual(
      (await hub.channelFiles(owner, channel.id)).map(file => file.id),
      [brief.id],
    )
    assert.equal((await hub.readChannelFile(owner, channel.id, brief.id)).bytes.toString(), '# Launch brief\n')
    const reply = await until(
      () => chat.messages().find(message => message.author.kind === 'session' && message.author.handle === 'writer'),
      'the writer reply',
    )
    assert.match(reply.text, /\[attached: brief\.md\]/)
    assert.match(reply.text, /\(read brief\.md: # Launch brief\)/)
    // A staged upload is used once.
    await assert.rejects(hub.post(owner, channel.id, 'post-again', '@writer again', [brief.id]), /expired/)
  } finally {
    await chat.close()
  }
})

test('a chat agent messages a session running in a terminal, and its reply comes back', async () => {
  const chat = await chatHarness(['Coder', 'Builder'], { terminal: ['Builder'] })
  try {
    const hub = await chat.startHub()
    const [coder, builder] = chat.sessions
    const link = await hub.link(chat.owner, chat.ref(coder))
    link.ensure(true)
    await until(() => link.state === 'live' && link.info?.state === 'ready', 'a ready chat')
    const sent = await link.request({
      type: 'prompt',
      key: 'to-terminal',
      origin: { kind: 'user' },
      prompt: [{ type: 'text', text: 'message @builder: please run the tests' }],
      files: [],
    })
    assert.equal(sent.ok, true, sent.message)
    // The message goes to the terminal, marked with its sender.
    const typed = await until(() => chat.terminal.typed.find(item => item.session === builder.id), 'the typed message')
    assert.match(typed.text, /^\[Outpost: .*@coder.*\]\n/)
    assert.match(typed.text, /please run the tests/)
    const delivery = chat.deliveries().find(item => item.sessionId === builder.id)!
    assert.equal(delivery.via, 'terminal')
    chat.terminal.answer(typed.key, 'All 42 tests pass')
    await until(() => chat.deliveries().find(item => item.sessionId === builder.id)?.state === 'done', 'its reply')
    // The reply reaches the coder's chat as a new turn.
    const reply = await until(
      () => chat.deliveries().find(item => item.sessionId === coder.id && item.source.kind === 'session'),
      'the reply delivery',
    )
    await until(() => chat.deliveries().find(item => item.id === reply.id)?.state === 'done', 'the reply turn')
    assert.ok(
      chat.hosts
        .get(coder.id)!
        .journal.entries.some(
          entry => entry.kind === 'queued' && JSON.stringify(entry.prompt).includes('All 42 tests pass'),
        ),
    )
  } finally {
    await chat.close()
  }
})

test("agents' tools: machines, channel posts within their channels, other sessions' files, and a send limit", async () => {
  const chat = await chatHarness(['Coder', 'Writer'])
  try {
    const hub = await chat.startHub()
    const [coder, writer] = chat.sessions
    const call = (tool: string, args: Record<string, unknown> = {}) =>
      hub.agent(chat.owner, chat.ref(coder), tool, args)
    assert.deepEqual(await call('list_machines'), {
      machines: [{ machine: 'Workstation', sessions: 2, reachable: true }],
    })
    const listed = (await call('list_sessions')) as { sessions: { handle: string }[]; channels: string[] }
    assert.deepEqual(
      listed.sessions.map(item => item.handle),
      ['@writer'],
    )

    const channel = await hub.saveChannel(chat.owner, {
      name: 'release',
      topic: '',
      members: [chat.ref(coder), chat.ref(writer)],
    })
    assert.deepEqual(((await call('list_sessions')) as { channels: string[] }).channels, ['#release'])
    assert.deepEqual(await call('post_to_channel', { channel: '#release', message: 'Notes are drafted' }), {
      posted: true,
      channel: '#release',
    })
    await until(() => chat.messages().find(message => message.text === 'Notes are drafted'), 'the post')
    const post = chat.messages().find(message => message.text === 'Notes are drafted')!
    assert.equal(post.author.kind === 'session' && post.author.sessionId, coder.id)
    assert.equal(post.channelId, channel.id)
    await assert.rejects(call('post_to_channel', { channel: '#elsewhere', message: 'Hi' }), /not in #elsewhere/)

    // A file the writer received, copied into the coder's session.
    await chat.files.receive(null, writer.id, 'plan.txt', Buffer.from('The plan\n'))
    const fetched = (await call('fetch_file', { session: '@writer', file: 'plan.txt' })) as {
      file: { id: string; name: string }
    }
    assert.equal(fetched.file.name, 'plan.txt')
    assert.deepEqual((await chat.files.read(null, coder.id, fetched.file.id)).bytes, Buffer.from('The plan\n'))
    await assert.rejects(call('fetch_file', { session: '@writer', file: 'missing.txt' }), /has no file missing\.txt/)

    // Posts and messages share a per-minute limit.
    for (let index = 1; index < chatLimits.sendsPerMinute; index++)
      await call('post_to_channel', { channel: 'release', message: `Update ${index}` })
    await assert.rejects(call('post_to_channel', { channel: 'release', message: 'One too many' }), /Too many/)
  } finally {
    await chat.close()
  }
})
