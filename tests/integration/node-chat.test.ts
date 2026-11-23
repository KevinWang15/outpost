import { createHash } from 'node:crypto'
// Chat through a machine's node: the chat host, its conversation in the session
// timeline, files, Outpost tools and one driver at a time, on a local target.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { streamWindow, type AgentCall } from '../../shared/machine'
import { chatHost, type ChatEntry, type ChatHostMessage, type ChatHostRequest } from '../../shared/chatHost'
import { currentConversation, type SessionInput, type Target } from '../../shared/model'
import { FrameDecoder, terminalControl, terminalFrame } from '../../shared/node/terminalFrames'
import type { Stream } from '../../backend/machines'
import { SessionFileClient } from '../../backend/sessionFiles'
import { SessionClient } from '../../backend/sessions'
import { localMachine } from './helpers'

const settings: Target = {
  kind: 'local',
  id: 'chat-machine',
  name: 'Chat machine',
  createdAt: '2026-11-01T00:00:00Z',
}

/** One connection to a session's chat host, as the server's chat hub holds it. */
class ChatClient {
  messages: ChatHostMessage[] = []
  closed = false
  private seen = 0
  private decoder = new FrameDecoder()
  constructor(private stream: Stream) {
    stream.onData(bytes => {
      for (const frame of this.decoder.feed(bytes)) this.messages.push(JSON.parse(frame.payload.toString()))
    })
    stream.onClose(() => (this.closed = true))
    this.send({ type: 'hello', protocol: chatHost.protocol })
  }
  send(message: ChatHostRequest) {
    this.stream.write(terminalControl(message))
  }
  async expect<T extends ChatHostMessage>(predicate: (message: ChatHostMessage) => boolean, timeout = 20_000) {
    const deadline = Date.now() + timeout
    for (;;) {
      for (let index = this.seen; index < this.messages.length; index++)
        if (predicate(this.messages[index])) {
          this.seen = index + 1
          return this.messages[index] as T
        }
      if (this.closed) throw new Error(`The chat closed; last: ${JSON.stringify(this.messages.slice(-3))}`)
      if (Date.now() > deadline) throw new Error(`Timed out; last: ${JSON.stringify(this.messages.slice(-3))}`)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  entry = <K extends ChatEntry['kind']>(
    kind: K,
    extra: (entry: Extract<ChatEntry, { kind: K }>) => boolean = () => true,
  ) =>
    this.expect<{ type: 'entry'; entry: Extract<ChatEntry, { kind: K }> }>(
      message => message.type === 'entry' && message.entry.kind === kind && extra(message.entry as never),
    )
  result = (id: string) =>
    this.expect<Extract<ChatHostMessage, { type: 'result' }>>(message => message.type === 'result' && message.id === id)
  ready = () =>
    this.expect<Extract<ChatHostMessage, { type: 'info' | 'welcome' }>>(
      message => (message.type === 'info' || message.type === 'welcome') && message.info.state === 'ready',
    )
  prompt(id: string, text: string, files: string[] = [], key: string | null = null) {
    this.send({ type: 'prompt', id, key, origin: { kind: 'user' }, prompt: [{ type: 'text', text }], files })
  }
  /** The agent's reply text in a turn. */
  reply(turn?: string) {
    return this.messages
      .flatMap(message =>
        message.type === 'entry' &&
        message.entry.kind === 'update' &&
        (turn === undefined || message.entry.turn === turn) &&
        message.entry.update.sessionUpdate === 'agent_message_chunk' &&
        message.entry.update.content.type === 'text'
          ? [message.entry.update.content.text]
          : [],
      )
      .join('')
  }
  async closedNow(timeout = 15_000) {
    const deadline = Date.now() + timeout
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error('The chat is still open')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
}

async function waitFor(check: () => boolean, message: string) {
  const until = Date.now() + 15_000
  while (!check()) {
    if (Date.now() > until) throw Error(message)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function terminalViewer(stream: Stream) {
  const decoder = new FrameDecoder()
  let output = ''
  const events: { type: string; id?: string; ok?: boolean; message?: string; files?: { name: string }[] }[] = []
  stream.onData(bytes => {
    for (const frame of decoder.feed(bytes)) {
      if (frame.kind === 'O') output += frame.payload.toString()
      else if (frame.kind === 'C') events.push(JSON.parse(frame.payload.toString()))
    }
  })
  return {
    events,
    ready: () => waitFor(() => events.some(m => m.type === 'ready'), 'Terminal did not become ready'),
    text: (value: string) => waitFor(() => output.includes(value), 'Missing terminal text: ' + value),
    input: (data: string) => stream.write(terminalFrame('I', Buffer.from(data))),
    send: (control: object) => stream.write(terminalControl(control)),
    close: () => stream.end(),
  }
}

async function machine(t: TestContext) {
  const { home, machines, context, streams } = await localMachine(t, 'outpost-node-chat-', settings)
  const calls: AgentCall[] = []
  machines.agent = async (_owner, _target, call) => {
    calls.push(call)
    return { sessions: [{ name: 'Other', handle: '@other' }] }
  }
  const sessions = new SessionClient()
  const project = join(home, 'project')
  const create = (input: Partial<SessionInput> = {}) =>
    sessions.create(context, { name: 'Chat', rootDir: '~/project', tool: 'claude', createDirectory: true, ...input })
  const open = async (id: string, start = true) => {
    const stream = await sessions.chatAttach(context, id, start)
    streams.push(stream)
    return new ChatClient(stream)
  }
  return { home, context, sessions, files: new SessionFileClient(), calls, project, create, open }
}

test(
  'chat records the conversation it starts, runs turns and continues them after a restart',
  { timeout: 120_000 },
  async t => {
    const { context, sessions, create, open, project } = await machine(t)
    const session = await create({ instructions: 'Be brief.' })
    const chat = await open(session.id)
    const ready = await chat.ready()
    assert.equal(ready.info.instructions, 'applied')
    assert.equal(await readFile(join(project, 'system-prompt.txt'), 'utf8'), 'append:Be brief.')
    // The chat host records the agent's new conversation in the session before any prompt runs.
    const listed = await sessions.get(context, session.id)
    assert.equal(currentConversation(listed), ready.info.nativeId)
    assert.deepEqual([listed.driver, listed.status], ['chat', 'attached'])

    chat.prompt('p1', 'Check with permission', [], 'k1')
    const queued = await chat.result('p1')
    assert.equal(queued.ok, true, queued.message ?? 'Request failed')
    const turn = (queued.data as { turn: string }).turn
    const asked = await chat.entry('permission')
    assert.equal((await sessions.get(context, session.id)).activity.state, 'waiting')
    chat.send({ type: 'permission', id: 'a1', request: asked.entry.id, optionId: 'allow' })
    const ended = await chat.entry('ended')
    assert.deepEqual([ended.entry.turn, ended.entry.stopReason], [turn, 'end_turn'])
    // A retried prompt with the same key is the same turn.
    chat.prompt('p2', 'Check with permission', [], 'k1')
    assert.deepEqual((await chat.result('p2')).data, { turn, duplicate: true })

    const finished = (await sessions.get(context, session.id)).activity
    assert.equal(finished.state, 'finished')
    const terminal = terminalViewer(await sessions.attach(context, session.id, 80, 24, false))
    await terminal.ready()
    await terminal.text('Permission granted.')
    terminal.close()
    await assert.rejects(sessions.remove(context, session.id), { statusCode: 409 })
    const seen = await sessions.acknowledge(context, session.id, finished.completionId!)
    assert.equal(seen.activity.state, 'idle')

    const stopped = await sessions.terminate(context, session.id)
    assert.equal(stopped.driver, null)
    await chat.closedNow()
    await assert.rejects(open(session.id, false), { statusCode: 410 })

    // A restart loads the same conversation and replays it as history.
    const again = await open(session.id)
    const welcome = await again.expect<Extract<ChatHostMessage, { type: 'welcome' }>>(
      message => message.type === 'welcome',
    )
    if (welcome.info.state !== 'ready') await again.ready()
    assert.equal(welcome.info.nativeId, ready.info.nativeId)
    const entries = [
      ...welcome.journal.entries,
      ...again.messages.flatMap(message => (message.type === 'entry' ? [message.entry] : [])),
    ]
    assert.deepEqual(
      entries.flatMap(entry =>
        entry.kind === 'update' && entry.turn === null && entry.update.sessionUpdate !== 'tool_call'
          ? 'content' in entry.update && entry.update.content && 'text' in entry.update.content
            ? [entry.update.content.text]
            : []
          : [],
      ),
      ['Check with permission', 'Permission granted.'],
    )
  },
)

test("an agent's Outpost tools reach the server; queued prompts can be withdrawn", { timeout: 120_000 }, async t => {
  const { create, open, calls } = await machine(t)
  const session = await create()
  const chat = await open(session.id)
  await chat.ready()
  chat.prompt('p1', 'list sessions please')
  const turn = ((await chat.result('p1')).data as { turn: string }).turn
  await chat.entry('ended', entry => entry.turn === turn)
  assert.deepEqual(
    calls.map(call => [call.session, call.tool]),
    [[session.id, 'list_sessions']],
  )
  assert.match(chat.reply(turn), /"Other"/)

  // A long turn runs; a second prompt waits and can be withdrawn.
  chat.prompt('p2', 'wait here')
  const running = ((await chat.result('p2')).data as { turn: string }).turn
  chat.prompt('p3', 'later')
  const waiting = ((await chat.result('p3')).data as { turn: string }).turn
  chat.send({ type: 'unqueue', id: 'u1', turn: waiting })
  assert.equal((await chat.result('u1')).ok, true)
  chat.send({ type: 'cancel', id: 'c1' })
  const cancelled = await chat.entry('ended', entry => entry.stopReason === 'cancelled')
  assert.equal(cancelled.entry.turn, running)
})

test(
  'the node acknowledges a detached chat and a cancelled download while keeping its machine connection usable',
  { timeout: 20_000 },
  async t => {
    const { context, create, files, sessions } = await machine(t)
    const session = await create()
    const detached = (stream: Stream) =>
      new Promise<void>((resolve, reject) => stream.onClose(error => (error ? reject(error) : resolve())))
    const chat = await sessions.chatAttach(context, session.id, true)
    const chatClosed = detached(chat)
    chat.end()
    await chatClosed

    const data = Buffer.alloc(streamWindow + 256 * 1024, 7)
    const stored = await files.receive(context, session.id, 'large.bin', data, AbortSignal.timeout(10_000))
    // An unclaimed file-receive stream must discard even a complete, zero-byte upload.
    const empty = await context.machine.open('file-receive', { session: session.id, name: 'abandoned', size: 0 })
    const emptyClosed = detached(empty)
    context.machine.send({ type: 'close', stream: empty.id, error: { status: 499, message: 'Cancelled' } })
    await assert.rejects(emptyClosed, { statusCode: 499 })
    assert.deepEqual(await files.list(context, session.id, AbortSignal.timeout(10_000)), [stored])

    const stream = await context.machine.open('file-read', { session: session.id, file: stored.id })
    stream.pause()
    const downloadClosed = detached(stream)
    let received = 0
    await new Promise<void>(resolve =>
      stream.onData(bytes => {
        received += bytes.length
        if (received >= streamWindow) resolve()
      }),
    )
    stream.end()
    await downloadClosed
    assert.ok(received < data.length)

    // A request can disconnect after the machine opened the file but before read() takes over.
    const controller = new AbortController()
    const open = context.machine.open.bind(context.machine)
    let abandoned: Promise<void> | undefined
    t.mock.method(
      context.machine,
      'open',
      async (...args: Parameters<typeof open>) => {
        const opened = await open(...args)
        abandoned = detached(opened)
        controller.abort()
        return opened
      },
      { times: 1 },
    )
    await assert.rejects(files.read(context, session.id, stored.id, controller.signal), { name: 'AbortError' })
    await abandoned

    const read = await files.read(context, session.id, stored.id, AbortSignal.timeout(10_000))
    assert.deepEqual(read.bytes, data)
  },
)

test('a lost machine connection removes a partially uploaded file', { timeout: 20_000 }, async t => {
  const { home, context, create } = await machine(t)
  const session = await create()
  const upload = await context.machine.open('file-receive', { session: session.id, name: 'partial.bin', size: 100 })
  const directory = join(home, '.outpost', 'files', session.id)
  const [staging] = readdirSync(directory)
  const partial = join(directory, staging, 'content', 'partial.bin')
  upload.write(Buffer.from('first chunk'))
  await waitFor(() => statSync(partial).size === 11, 'The machine did not receive the first chunk')
  context.machine.restart()
  await waitFor(() => readdirSync(directory).length === 0, 'The disconnected upload remained on disk')
})

test('files sent to the agent are stored, and linked where its own tools read them', { timeout: 120_000 }, async t => {
  const { context, create, open, files } = await machine(t)
  const session = await create()
  const data = Buffer.from('Ship on Friday\n')
  const stored = await files.receive(context, session.id, 'notes v2.txt', data, AbortSignal.timeout(10_000))
  assert.deepEqual([stored.name, stored.size, stored.source], ['notes v2.txt', data.length, 'received'])
  assert.deepEqual(
    (await files.list(context, session.id, AbortSignal.timeout(10_000))).map(file => file.id),
    [stored.id],
  )
  await assert.rejects(files.receive(context, session.id, 'a/b.txt', data, AbortSignal.timeout(10_000)), /filename/)
  const read = await files.read(context, session.id, stored.id, AbortSignal.timeout(10_000))
  assert.deepEqual(read.bytes, data)

  const chat = await open(session.id)
  await chat.ready()
  chat.prompt('f1', 'Summarize', [stored.id])
  const queued = await chat.entry('queued')
  const link = queued.entry.prompt.at(-1)!
  assert.equal(link.type, 'resource_link')
  assert.equal(link.type === 'resource_link' && link.name, 'notes v2.txt')
  await chat.entry('ended')
  assert.match(chat.reply(), /\(read notes v2\.txt: Ship on Friday\)/)
  chat.prompt('f2', '', ['0'.repeat(32)])
  const missing = await chat.result('f2')
  assert.equal(missing.ok, false)
  assert.match(missing.message!, /no longer in this session/)
})

test('DeepSeek resumes the same conversation from either view', { timeout: 120_000 }, async t => {
  const { context, sessions, create, open, project } = await machine(t)
  const session = await create({ name: 'DeepSeek named session', tool: 'deepseek' })
  const native = currentConversation(session)
  const chat = await open(session.id)
  assert.equal((await chat.ready()).info.nativeId, native)
  chat.prompt('d1', 'publish deepseek-result.txt')
  assert.equal((await chat.entry('ended')).entry.stopReason, 'end_turn')
  await readFile(join(project, 'deepseek-result.txt'))
  assert.ok(chat.messages.some(message => message.type === 'entry' && message.entry.kind === 'file'))
  await sessions.terminate(context, session.id)
  const reopened = await open(session.id)
  assert.equal((await reopened.ready()).info.nativeId, native)
  await sessions.terminate(context, session.id)
  const terminal = terminalViewer(await sessions.attach(context, session.id, 80, 24, true))
  await terminal.ready()
  assert.equal((await sessions.get(context, session.id)).driver, 'chat')
  terminal.close()
})

test('chat starts with the session model, mode and MCP servers', { timeout: 120_000 }, async t => {
  const { create, open, project, sessions, context } = await machine(t)
  const mcpServers = {
    local: { command: 'local-mcp', args: ['--stdio'] },
    remote: { type: 'http' as const, url: 'https://example.com/mcp' },
  }
  const notices = (chat: ChatClient, ready: Awaited<ReturnType<ChatClient['ready']>>) =>
    [
      ...(ready.type === 'welcome' ? ready.journal.entries : []),
      ...chat.messages.flatMap(message => (message.type === 'entry' ? [message.entry] : [])),
    ].flatMap(entry => (entry.kind === 'notice' ? [entry.text] : []))
  const current = (ready: Awaited<ReturnType<ChatClient['ready']>>, id: string) =>
    ready.info.config.find(option => option.id === id)?.currentValue

  // Names match the tool's choices by ID or, ignoring case, by name.
  const claude = await create({ name: 'Claude', model: 'deep', mode: 'auto', mcpServers })
  const chat = await open(claude.id)
  const ready = await chat.ready()
  assert.deepEqual([current(ready, 'model'), current(ready, 'mode')], ['fixture-deep', 'auto'])
  assert.deepEqual(JSON.parse(await readFile(join(project, 'mcp-servers.json'), 'utf8')), [
    'outpost',
    'local',
    'remote',
  ])
  assert.deepEqual(notices(chat, ready), [])
  await sessions.terminate(context, claude.id)

  // Kimi gets Outpost's server from its plugin, and its ACP server takes no URLs.
  const kimi = await create({ name: 'Kimi', tool: 'kimi', model: 'Unknown', mcpServers })
  const other = await open(kimi.id)
  const started = await other.ready()
  assert.equal(current(started, 'model'), 'fixture-fast')
  assert.deepEqual(JSON.parse(await readFile(join(project, 'mcp-servers.json'), 'utf8')), ['local'])
  const said = notices(other, started)
  assert.ok(
    said.some(text => /MCP servers by URL.*remote was not added/.test(text)),
    said.join('\n'),
  )
  assert.ok(said.some(text => /model Unknown is not one this coding tool offers \(Fast, Deep\)/.test(text)))
})

test(
  "Kimi chats get Outpost's tools from its plugin and report unsupported instructions",
  { timeout: 120_000 },
  async t => {
    const { create, open, calls } = await machine(t)
    const session = await create({ tool: 'kimi', instructions: 'Be brief.' })
    const chat = await open(session.id)
    const ready = await chat.ready()
    assert.equal(ready.info.instructions, 'unsupported')
    assert.equal(ready.info.nativeId, currentConversation(session))
    const entries = [
      ...(ready.type === 'welcome' ? ready.journal.entries : []),
      ...chat.messages.flatMap(message => (message.type === 'entry' ? [message.entry] : [])),
    ]
    assert.ok(entries.some(entry => entry.kind === 'notice' && /instructions/.test(entry.text)))
    chat.prompt('p1', 'list sessions')
    assert.equal((await chat.entry('ended')).entry.stopReason, 'end_turn')
    assert.deepEqual(
      calls.map(call => call.tool),
      ['list_sessions'],
    )
    assert.match(chat.reply(), /Other/)
  },
)

test(
  "Antigravity chats apply instructions, accept HTTP MCP servers, get Outpost's tools, and replay history",
  { timeout: 120_000 },
  async t => {
    const { context, sessions, create, open, project, calls } = await machine(t)
    const mcpServers = {
      local: { command: 'local-mcp', args: ['--stdio'] },
      remote: { type: 'http' as const, url: 'https://example.com/mcp' },
    }
    const session = await create({
      name: 'Antigravity',
      tool: 'antigravity',
      instructions: 'Keep it concise.',
      mcpServers,
    })
    const native = currentConversation(session)
    const chat = await open(session.id)
    const ready = await chat.ready()
    assert.equal(ready.info.instructions, 'applied')
    assert.equal(ready.info.nativeId, native)
    assert.equal(await readFile(join(project, 'system-prompt.txt'), 'utf8'), 'append:Keep it concise.')
    assert.deepEqual(JSON.parse(await readFile(join(project, 'mcp-servers.json'), 'utf8')), [
      'outpost',
      'local',
      'remote',
    ])
    chat.prompt('a1', 'list sessions')
    assert.equal((await chat.entry('ended')).entry.stopReason, 'end_turn')
    assert.deepEqual(
      calls.map(call => call.tool),
      ['list_sessions'],
    )
    await sessions.terminate(context, session.id)
    const reopened = await open(session.id)
    assert.equal((await reopened.ready()).info.nativeId, native)
  },
)

test('simultaneous first connections start exactly one agent', { timeout: 90_000 }, async t => {
  const { home, create, open, context, sessions } = await machine(t)
  const session = await create()
  const [chat, terminal] = await Promise.all([
    open(session.id),
    sessions.attach(context, session.id, 90, 30, true).then(terminalViewer),
  ])
  const [view] = await Promise.all([chat.ready(), terminal.ready()])
  const sockets = await Promise.all(
    ['terminals', 'chats'].map(
      async dir =>
        (await stat(join(home, '.outpost', dir, session.id + '.sock')).catch(() => null))?.isSocket() ?? false,
    ),
  )
  assert.deepEqual(sockets, view.info.nativeTerminal ? [true, false] : [false, true])
  terminal.close()
})

test(
  'a terminal and a chat share the native agent, queue, attachments and conversation',
  { timeout: 90_000 },
  async t => {
    const { context, sessions, create, open, project, files } = await machine(t)
    const session = await create()
    await writeFile(join(project, 'capture-input'), '')
    await writeFile(join(project, 'answer-prompts'), '')
    const terminal = terminalViewer(await sessions.attach(context, session.id, 90, 30, true))
    await terminal.ready()
    // Early fixture output can already be in the terminal checkpoint when this viewer attaches.
    await waitFor(() => existsSync(join(project, 'sizes.log')), 'Native tool did not start')
    const pids = await readFile(join(project, 'starts.log'), 'utf8')
    const chat = await open(session.id, false)
    await chat.ready()
    terminal.send({ type: 'draft', active: true })
    const file = await files.receive(
      context,
      session.id,
      'shared.txt',
      Buffer.from('shared'),
      AbortSignal.timeout(10000),
    )
    chat.prompt('add', 'from the chat', [file.id], 'shared-test')
    assert.equal((await chat.result('add')).ok, true)
    await waitFor(() => JSON.stringify(chat.messages).includes('from the chat'), 'Chat did not show the queued message')
    terminal.send({ type: 'draft', active: false })
    await waitFor(
      () => JSON.stringify(chat.messages).includes('Fixture reply to: from the chat'),
      'Chat received no agent answer',
    )
    terminal.input('from the keyboard\r')
    await waitFor(
      () => JSON.stringify(chat.messages).includes('Fixture reply to: from the keyboard'),
      'Keyboard turn was missing from Chat',
    )
    const another = await open(session.id, false)
    const history = await another.ready()
    assert.match(JSON.stringify(history), /Fixture reply to: from the keyboard/)
    assert.match(JSON.stringify(history), /shared.txt/)
    assert.equal(await readFile(join(project, 'starts.log'), 'utf8'), pids)
    terminal.close()
  },
)

test(
  'an ACP session can be prompted and approved from a terminal while Chat stays open',
  { timeout: 90_000 },
  async t => {
    const { home, context, sessions, create, open } = await machine(t)
    const session = await create()
    const chat = await open(session.id)
    const original = await chat.ready()
    const terminal = terminalViewer(await sessions.attach(context, session.id, 90, 30, false))
    await terminal.ready()
    const pixels = await readFile('public/favicon-32x32.png')
    const paste = async (id: string) => {
      terminal.send({
        type: 'image-write',
        id: 'write-' + id,
        transfer: id,
        mime: 'image/png',
        size: pixels.length,
        offset: 0,
        chunk: pixels.toString('base64'),
      })
      terminal.send({ type: 'image-paste', id: 'paste-' + id, transfer: id, mode: 'attachment' })
      await waitFor(() => terminal.events.some(m => m.id === 'paste-' + id), 'Image paste was not confirmed')
      const result = terminal.events.find(m => m.id === 'paste-' + id)!
      assert.ok(result.ok, result.message ?? 'Image paste failed')
      await terminal.text('[Image 1]')
    }
    const directory = join(home, '.outpost', 'files', session.id)
    const staged = () => readdirSync(directory).filter(name => name.startsWith('.storing-'))
    await paste('cancel')
    assert.equal(staged().length, 1)
    terminal.input('\x03')
    await waitFor(() => staged().length === 0, 'Ctrl+C did not discard the staged image')
    await paste('remove')
    terminal.input('\x7f')
    terminal.send({ type: 'ping', id: 'removed' })
    await waitFor(() => terminal.events.some(m => m.id === 'removed'), 'Backspace was not processed')
    assert.deepEqual(readdirSync(directory), [])
    terminal.input('\x1b[20')
    terminal.input('0~first line\r\nsecond line\x1b[20')
    terminal.input('1~')
    terminal.send({ type: 'ping', id: 'pasted' })
    await waitFor(() => terminal.events.some(m => m.id === 'pasted'), 'Paste was not processed')
    assert.ok(!chat.messages.some(m => m.type === 'entry' && m.entry.kind === 'queued'))
    terminal.input('\r')
    const pasted = await chat.entry('queued')
    assert.deepEqual(pasted.entry.prompt, [{ type: 'text', text: 'first line\nsecond line' }])
    await chat.entry('ended')
    await paste('keep')
    terminal.input('identify clipboard pixels')
    terminal.send({ type: 'ping', id: 'draft-edited' })
    await waitFor(() => terminal.events.some(m => m.id === 'draft-edited'), 'Draft was not edited')
    assert.equal(chat.messages.filter(m => m.type === 'entry' && m.entry.kind === 'queued').length, 1)
    terminal.input('\r')
    await terminal.text('clipboard sha256 ' + createHash('sha256').update(pixels).digest('hex'))
    terminal.input('Check with permission\r')
    const ask = await chat.entry('permission')
    const command =
      '/answer ' + ask.entry.id.slice(0, 8) + ' ' + (ask.entry.options.findIndex(o => o.optionId === 'allow') + 1)
    await terminal.text(command)
    terminal.input(command + '\r')
    const done = await chat.entry('ended')
    assert.equal(done.entry.stopReason, 'end_turn')
    await terminal.text('Permission granted.')
    chat.send({ type: 'permission', id: 'late', request: ask.entry.id, optionId: 'allow' })
    assert.equal((await chat.result('late')).ok, false)
    await paste('unsubmitted')
    assert.equal(staged().length, 1)
    terminal.close()
    await waitFor(() => staged().length === 0, 'Disconnect did not discard the staged image')
    assert.equal(readdirSync(directory).length, 1, 'Only the submitted image is kept')
    const reconnect = await open(session.id, false)
    const same = await reconnect.ready()
    assert.equal(same.info.nativeId, original.info.nativeId)
    const instance = (viewer: ChatClient) => viewer.messages.find(m => m.type === 'welcome')?.instance
    assert.ok(instance(chat))
    assert.equal(instance(reconnect), instance(chat))
  },
)
