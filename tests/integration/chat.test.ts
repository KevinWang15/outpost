// The chat hub with real chat hosts and the scripted ACP agent, connected
// in-process instead of through SSH and the target runtime's relay.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { ChannelMessage, ChatServerMessage, Delivery } from '../../shared/chatApi'
import type { ChatHostMessage } from '../../shared/chatHost'
import { FrameDecoder, terminalControl } from '../../shared/node/terminalFrames'
import { LocalDeployment } from '../../backend/deployment'
import { ChatHub } from '../../backend/chat/hub'
import type { ChatConnector } from '../../backend/chat/links'
import { targetResolver } from '../../backend/services'
import { ChatHost } from '../../terminal-service/chat'
import { FakeSessions } from '../unit/fakes'

const root = fileURLToPath(new URL('../../', import.meta.url))
const fixture = join(root, 'tests/fixtures/acp-agent-fixture.py')

async function until<T>(check: () => T | undefined | null | false, label: string, timeout = 20_000): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

test('chat hub: channels pass the floor, sessions message each other, schedules fire', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'outpost-chat-hub-')))
  const state = join(directory, 'state')
  await mkdir(join(state, 'chats'), { recursive: true })
  const home = join(directory, 'claude')
  execFileSync(
    'python3',
    ['-c', 'import sys, pathlib, outpost_mcp_install as m; m.install(pathlib.Path(sys.argv[1]))', state],
    {
      env: { ...process.env, PYTHONPATH: join(root, 'runtime') },
    },
  )
  const previous = process.cwd()
  process.chdir(state) // Chat sockets are relative to the state directory.
  const hosts = new Map<string, ChatHost>()
  const sessions = new FakeSessions()
  const connector: ChatConnector = (context, sessionId, start, events) => {
    const session = sessions.sessions.get(context.target.id)!.find(item => item.id === sessionId)!
    let host = hosts.get(sessionId)
    if (!host) {
      if (!start) {
        setImmediate(() => events.closed('The chat stopped.', 410))
        return { send() {}, close() {} }
      }
      host = new ChatHost(
        {
          socket: `chats/${sessionId}.sock`,
          session: sessionId,
          command: ['python3', fixture],
          cwd: directory,
          env: { ...process.env, CLAUDE_CONFIG_DIR: home, FIXTURE_ACP_VARIANT: 'claude' } as Record<string, string>,
          resume: null,
          mcpServers: [
            {
              name: 'outpost',
              command: 'python3',
              args: ['-I', join(state, 'outpost-mcp')],
              env: [
                { name: 'OUTPOST_SESSION_ID', value: sessionId },
                { name: 'OUTPOST_STATE_DIRECTORY', value: state },
                { name: 'OUTPOST_CHAT_SOCKET', value: `chats/${sessionId}.sock` },
              ],
            },
          ],
          instructions: null,
        },
        { onExit: () => hosts.delete(sessionId) },
      )
      hosts.set(sessionId, host)
      void host.start()
    }
    const socket = connect(join(state, 'chats', `${sessionId}.sock`))
    const decoder = new FrameDecoder()
    const pending: Buffer[] = []
    let open = false
    socket.on('connect', () => {
      open = true
      for (const frame of pending.splice(0)) socket.write(frame)
    })
    socket.on('error', () => {})
    socket.on('close', () => events.closed('The connection to the chat was lost.', null))
    socket.on('data', bytes => {
      for (const frame of decoder.feed(Buffer.from(bytes))) {
        const message = JSON.parse(frame.payload.toString()) as ChatHostMessage
        if (message.type === 'identity') {
          // The target runtime's relay does this; see outpost_chat.Relay.
          session.cliSessionId = message.nativeId
          socket.write(terminalControl({ type: 'identity-saved', nativeId: message.nativeId }))
        }
        events.message(message)
      }
    })
    const write = (frame: Buffer) => (open ? socket.write(frame) : pending.push(frame))
    return { send: message => void write(terminalControl(message)), close: () => socket.destroy() }
  }
  const deployment = await LocalDeployment.open(join(directory, 'data'))
  const target = await deployment.workspace().add({
    id: 'workstation',
    kind: 'local',
    name: 'Workstation',
    tools: ['claude'],
    createdAt: new Date().toISOString(),
  })
  const resolve = targetResolver(deployment, false)
  const owner = deployment.owner()
  const context = await resolve(owner, target.id)
  const [coder, writer, reviewer] = await Promise.all(
    ['Coder', 'Writer', 'Reviewer'].map(name => sessions.create(context, { name, tool: 'claude', rootDir: directory })),
  )
  // Outpost's MCP server checks the target registry, as on a real target.
  await writeFile(
    join(state, 'registry.json'),
    JSON.stringify({ version: 2, sessions: [coder, writer, reviewer].map(session => ({ id: session.id })) }),
  )
  const hub = new ChatHub({
    deployment,
    resolve,
    list: async item => (await sessions.list(item)).sessions,
    connect: connector,
  })
  const received: ChatServerMessage[] = []
  try {
    const { account } = await hub.attach({ owner, send: message => received.push(message) })
    await hub.refreshFor(owner)
    assert.deepEqual(
      account.view.map(item => item.handle),
      ['coder', 'writer', 'reviewer'],
    )
    const ref = (session: { id: string }) => ({ targetId: target.id, sessionId: session.id })
    const channel = await hub.saveChannel(owner, {
      name: 'release',
      topic: 'Ship 1.2',
      members: [ref(coder), ref(writer)],
    })
    const messages = () =>
      received.flatMap(message => (message.type === 'message' ? [message.message as ChannelMessage] : []))
    const deliveries = () => {
      const latest = new Map<string, Delivery>()
      for (const message of received) if (message.type === 'delivery') latest.set(message.delivery.id, message.delivery)
      return [...latest.values()]
    }

    // A user message reaches only the member it mentions; its reply comes back.
    await hub.post(owner, channel.id, 'post1', '@coder check the build')
    const reply = await until(
      () => messages().find(message => message.author.kind === 'session' && message.author.handle === 'coder'),
      'the coder reply',
    )
    assert.match(reply.text, /^Fixture reply to: You are coder in the Outpost channel #release \(Ship 1\.2\)/)
    assert.deepEqual(reply.mentions, [])
    assert.equal(reply.hop, 1)
    assert.ok(reply.turn)
    assert.equal(deliveries().filter(item => item.sessionId === writer.id).length, 0)
    // The same post key is one post.
    assert.equal((await hub.post(owner, channel.id, 'post1', '@coder check the build')).duplicate, true)

    // Members that keep passing the floor are stopped after the hop limit.
    await hub.post(owner, channel.id, 'post2', '@coder pass the floor')
    const stopped = await until(
      () => messages().find(message => message.author.kind === 'outpost' && /stopped passing/.test(message.text)),
      'the floor limit',
      60_000,
    )
    const chain = messages().filter(message => message.root === stopped.root && message.author.kind === 'session')
    assert.equal(chain.at(-1)!.hop, 6)
    assert.deepEqual(
      chain.slice(0, 3).map(message => (message.author.kind === 'session' ? message.author.handle : '')),
      ['coder', 'writer', 'coder'],
    )

    // Session-to-session: the reviewer replies, and the reply returns to the coder.
    const coderLink = await hub.link(owner, ref(coder))
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
        deliveries().find(
          item =>
            item.sessionId === coder.id && item.source.kind === 'session' && item.source.reply && item.state === 'done',
        ),
      'the reply delivery',
      60_000,
    )
    assert.equal(back.source.kind === 'session' && back.source.from.sessionId, reviewer.id)
    const reviewerTurn = deliveries().find(item => item.sessionId === reviewer.id && item.source.kind === 'session')!
    assert.equal(reviewerTurn.state, 'done')

    // A schedule fires into the session's own chat and records its run.
    const schedule = await hub.saveSchedule(owner, {
      name: 'Morning check',
      ...ref(writer),
      prompt: 'Summarize overnight changes',
      cron: '0 9 * * 1-5',
      timeZone: 'UTC',
      enabled: true,
    })
    await hub.runSchedule(owner, schedule.id)
    const ran = await until(
      () =>
        received.flatMap(message =>
          message.type === 'schedule' && message.schedule.lastRun ? [message.schedule] : [],
        )[0],
      'the schedule run',
    )
    assert.equal(ran.lastRun!.ok, true)
    await assert.rejects(hub.saveSchedule(owner, { ...schedule, cron: '61 * * * *' }), /Invalid minute/)
  } finally {
    hub.close()
    for (const host of hosts.values()) host.stop()
    process.chdir(previous)
    await new Promise(resolve => setTimeout(resolve, 500))
    await rm(directory, { recursive: true, force: true })
  }
})
