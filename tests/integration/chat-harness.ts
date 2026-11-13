// The chat hub with real chat hosts and the scripted ACP agent, connected
// in-process instead of through SSH and the target runtime's relay, with
// faults a test can inject into that connection.
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChatServerMessage, ChannelMessage, Delivery } from '../../shared/chatApi'
import type { ChatHostMessage, ChatHostRequest } from '../../shared/chatHost'
import { parseSessionFile } from '../../shared/sessionFiles'
import { FrameDecoder, terminalControl } from '../../shared/node/terminalFrames'
import type { Session } from '../../shared/model'
import { LocalDeployment } from '../../backend/deployment'
import { ChatHub } from '../../backend/chat/hub'
import type { ChatConnector } from '../../backend/chat/links'
import { targetResolver } from '../../backend/services'
import { ChatHost } from '../../terminal-service/chat'
import { FakeSessions } from '../unit/fakes'

const root = fileURLToPath(new URL('../../', import.meta.url))
const fixture = join(root, 'tests/fixtures/acp-agent-fixture.py')

export async function until<T>(check: () => T | undefined | null | false, label: string, timeout = 20_000): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}
export const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export async function chatHarness(names: string[], options: { idleMs?: number } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'outpost-chat-hub-')))
  const state = join(directory, 'state')
  await mkdir(join(state, 'chats'), { recursive: true })
  const home = join(directory, 'claude')
  execFileSync(
    'python3',
    ['-c', 'import sys, pathlib, outpost_mcp_servers as m; m.install(pathlib.Path(sys.argv[1]))', state],
    { env: { ...process.env, PYTHONPATH: join(root, 'runtime') } },
  )
  const previous = process.cwd()
  process.chdir(state) // Chat sockets are relative to the state directory.
  const hosts = new Map<string, ChatHost>()
  const sockets = new Map<string, Set<Socket>>()
  /** Faults: answers from the host are discarded (the request still reaches it). */
  const muted = new Set<string>()
  /** Faults: the connection breaks instead of carrying an `answer` to the host. */
  const breakOnAnswer = new Set<string>()
  /** Faults: the connection ends right after carrying a prompt, before any confirmation. */
  const cutAfterPrompt = new Set<string>()
  /** Faults: the connection stays open but nothing arrives from the host. */
  const frozen = new Set<string>()
  const sessions = new FakeSessions()

  function startHost(session: Session) {
    const host = new ChatHost(
      {
        socket: `chats/${session.id}.sock`,
        session: session.id,
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
              { name: 'OUTPOST_SESSION_ID', value: session.id },
              { name: 'OUTPOST_STATE_DIRECTORY', value: state },
              { name: 'OUTPOST_DRIVER', value: 'chat' },
            ],
          },
        ],
        instructions: null,
      },
      { onExit: () => hosts.get(session.id) === host && hosts.delete(session.id), idleMs: options.idleMs },
    )
    hosts.set(session.id, host)
    void host.start()
    return host
  }

  const connector: ChatConnector = (context, sessionId, start, events) => {
    const session = sessions.sessions.get(context.target.id)!.find(item => item.id === sessionId)!
    if (!hosts.has(sessionId)) {
      if (!start) {
        setImmediate(() => events.closed('The chat stopped.', 410))
        return { send() {}, close() {} }
      }
      startHost(session)
    }
    const socket = connect(join(state, 'chats', `${sessionId}.sock`))
    const open = sockets.get(sessionId) ?? new Set()
    open.add(socket)
    sockets.set(sessionId, open)
    const decoder = new FrameDecoder()
    const pending: Buffer[] = []
    let connected = false
    socket.on('connect', () => {
      connected = true
      for (const frame of pending.splice(0)) socket.write(frame)
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      open.delete(socket)
      events.closed('The connection to the chat was lost.', null)
    })
    socket.on('data', bytes => {
      if (frozen.has(sessionId)) return
      events.progress()
      for (const frame of decoder.feed(Buffer.from(bytes))) {
        const message = JSON.parse(frame.payload.toString()) as ChatHostMessage
        if (message.type === 'identity') {
          // The target runtime's relay does this; see outpost_chat.Relay.
          session.cliSessionId = message.nativeId
          socket.write(terminalControl({ type: 'identity-saved', nativeId: message.nativeId }))
        }
        if (message.type === 'result' && muted.has(sessionId)) continue
        events.message(message)
      }
    })
    const write = (message: ChatHostRequest) => {
      if (message.type === 'answer' && breakOnAnswer.has(sessionId)) {
        breakOnAnswer.delete(sessionId)
        return void socket.destroy()
      }
      const frame = terminalControl(message)
      if (connected) socket.write(frame)
      else pending.push(frame)
      if (message.type === 'prompt' && cutAfterPrompt.delete(sessionId)) {
        if (connected) socket.end()
        else socket.once('connect', () => socket.end())
      }
    }
    return { send: write, close: () => socket.destroy() }
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
  const created = []
  for (const name of names) created.push(await sessions.create(context, { name, tool: 'claude', rootDir: directory }))
  // Outpost's MCP server checks the target registry, as on a real target.
  await writeFile(
    join(state, 'registry.json'),
    JSON.stringify({ version: 2, sessions: created.map(session => ({ id: session.id })) }),
  )
  /** The session list as the target runtime describes it: a running host drives the session. */
  const list = async () =>
    created.map(session => {
      const host = hosts.get(session.id)
      const status = host?.status()
      return status
        ? { ...session, driver: 'chat' as const, status: 'attached' as const, activity: status.activity }
        : session
    })

  const hubs: ChatHub[] = []
  const received: ChatServerMessage[] = []
  /** Session files through the target's own file store (runtime/outpost_files.py). */
  const store = (script: string, args: string[], input?: Buffer) =>
    execFileSync(
      'python3',
      [
        '-c',
        `import json, pathlib, sys, outpost_files as f; f.STATE = pathlib.Path(sys.argv[1]); ${script}`,
        state,
        ...args,
      ],
      { env: { ...process.env, PYTHONPATH: join(root, 'runtime') }, input },
    )
  const files = {
    receive: async (_context: unknown, sessionId: string, name: string, data: Buffer) =>
      parseSessionFile(
        JSON.parse(
          store(
            'print(json.dumps(f.receive(sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.stdin.buffer)))',
            [sessionId, name, String(data.length)],
            data,
          ).toString(),
        ),
      ),
    read: async (_context: unknown, sessionId: string, fileId: string) => {
      const output = store(
        'm, s = f.read_file(sys.argv[2], sys.argv[3]); sys.stdout.buffer.write(json.dumps(m).encode() + b"\\n" + s.read())',
        [sessionId, fileId],
      )
      const end = output.indexOf(10)
      return { file: parseSessionFile(JSON.parse(output.subarray(0, end).toString())), bytes: output.subarray(end + 1) }
    },
  }

  async function startHub(timing: { promptMs?: number; probeMs?: number } = {}) {
    const hub = new ChatHub({ deployment, resolve, list, files, connect: connector, ...timing })
    hubs.push(hub)
    await hub.start()
    await hub.attach({ owner, send: message => received.push(message) })
    await hub.refreshFor(owner)
    return hub
  }

  return {
    owner,
    target,
    sessions: created,
    files,
    hosts,
    received,
    muted,
    breakOnAnswer,
    cutAfterPrompt,
    frozen,
    startHub,
    ref: (session: { id: string }) => ({ targetId: target.id, sessionId: session.id }),
    /** Break every connection to a session's chat host; the host keeps running. */
    drop(session: { id: string }) {
      for (const socket of sockets.get(session.id) ?? []) socket.destroy()
    },
    messages: () =>
      received.flatMap(message => (message.type === 'message' ? [message.message as ChannelMessage] : [])),
    deliveries: () => {
      const latest = new Map<string, Delivery>()
      for (const message of received) if (message.type === 'delivery') latest.set(message.delivery.id, message.delivery)
      return [...latest.values()]
    },
    /** Turns a session's chat host actually started, by origin kind. */
    turns: (session: { id: string }) =>
      (hosts.get(session.id)?.journal.entries ?? []).filter(entry => entry.kind === 'started').length,
    async close() {
      for (const hub of hubs) hub.close()
      for (const host of hosts.values()) host.stop()
      process.chdir(previous)
      await pause(500)
      await rm(directory, { recursive: true, force: true })
    },
  }
}
