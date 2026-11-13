// Chat through a machine's node: the chat host, its conversation in the session
// timeline, files, Outpost tools and one driver at a time, on a local target.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { AgentCall } from '../../shared/machine'
import { chatHost, type ChatEntry, type ChatHostMessage, type ChatHostRequest } from '../../shared/chatHost'
import { currentConversation, type SessionInput, type Target } from '../../shared/model'
import { FrameDecoder, terminalControl } from '../../shared/node/terminalFrames'
import { Machines, type Stream } from '../../backend/machines'
import { SessionFileClient } from '../../backend/sessionFiles'
import { SessionClient, type TargetContext } from '../../backend/sessions'
import { transportFor } from '../../backend/transport'
import { fixtureHome, removeHome } from './helpers'

const settings: Target = {
  kind: 'local',
  id: 'chat-machine',
  name: 'Chat machine',
  tools: ['claude', 'codex', 'kimi', 'deepseek'],
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

async function machine(t: TestContext) {
  const { directory, home, env } = await fixtureHome('outpost-node-chat-')
  const calls: AgentCall[] = []
  const machines = new Machines('node-chat', env)
  machines.agent = async (_owner, _target, call) => {
    calls.push(call)
    return { sessions: [{ name: 'Other', handle: '@other' }] }
  }
  const owner = { userId: 'local', loginId: 'local' }
  const transport = transportFor(settings, null, { scope: 'local' })
  const context = {
    owner,
    target: settings,
    transport,
    machine: machines.get(owner, settings.id, transport),
    workspace: null,
  } as unknown as TargetContext
  const sessions = new SessionClient()
  const streams: Stream[] = []
  t.after(async () => {
    for (const stream of streams) stream.end()
    machines.close()
    await removeHome(directory, home)
  })
  const project = join(home, 'project')
  const create = (input: Partial<SessionInput> = {}) =>
    sessions.create(context, { name: 'Chat', rootDir: '~/project', tool: 'claude', createDirectory: true, ...input })
  const open = async (id: string, start = true) => {
    const stream = await sessions.chatAttach(context, id, start)
    streams.push(stream)
    return new ChatClient(stream)
  }
  return { context, sessions, files: new SessionFileClient(), calls, project, create, open }
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
    assert.equal(queued.ok, true, queued.message)
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
    // One driver at a time: the terminal refuses while the chat runs, and so does deletion.
    await assert.rejects(sessions.attach(context, session.id, 80, 24, true), { statusCode: 409 })
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

test('DeepSeek chats resume their exact conversation and have no terminal', { timeout: 120_000 }, async t => {
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
  await assert.rejects(sessions.attach(context, session.id, 80, 24, true), { statusCode: 409, message: /chat/i })
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
