// The chat hub with real chat hosts, the real Outpost MCP server and the
// scripted ACP agent, connected in-process instead of through a machine
// connection, with faults a test can inject into that connection.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChatServerMessage, ChannelMessage, Delivery } from '../../shared/chatApi'
import type { ChatHostMessage, ChatHostRequest } from '../../shared/chatHost'
import { FrameDecoder, terminalControl } from '../../shared/node/terminalFrames'
import type { SessionRecord } from '../../shared/model'
import { LocalDeployment } from '../../backend/deployment'
import { ChatHub } from '../../backend/chat/hub'
import type { ChatConnector } from '../../backend/chat/links'
import { Machines } from '../../backend/machines'
import { targetResolver } from '../../backend/services'
import { ChatHost } from '../../machine/chat'
import { listFiles, readFile as storedFile, StoredFile } from '../../machine/files'
import { changeRegistry } from '../../machine/registry'
import { listSessions } from '../../machine/sessions'
import { state as machineState, statePath, writeJson } from '../../machine/state'
import type { TerminalDelivery } from '../../backend/sessions'
import { terminalBinary } from './helpers'

const root = fileURLToPath(new URL('../../', import.meta.url))
const fixture = join(root, 'tests/fixtures/acp-agent-fixture.py')
/** The agent endpoint a node would serve for this account and machine. */
const nodeSocket = `run/node-${'0'.repeat(32)}.sock`

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

export async function chatHarness(names: string[], options: { idleMs?: number; terminal?: string[] } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'outpost-chat-hub-')))
  const state = join(directory, 'state')
  await mkdir(join(state, 'chats'), { recursive: true })
  const home = join(directory, 'claude')
  // The machine's own modules (registry, files, sessions) run in-process on this state.
  const previous = machineState.directory
  machineState.directory = state
  const hosts = new Map<string, ChatHost>()
  const sockets = new Map<string, Set<Socket>>()
  /** Faults: answers from the host are discarded (the request still reaches it). */
  const muted = new Set<string>()
  /** Faults: the connection ends right after carrying a prompt, before any confirmation. */
  const cutAfterPrompt = new Set<string>()
  /** Faults: the connection stays open but nothing arrives from the host. */
  const frozen = new Set<string>()

  const created: SessionRecord[] = names.map(name => ({
    id: randomUUID(),
    name,
    tool: 'claude',
    rootDir: directory,
    createdAt: new Date().toISOString(),
    lastConnectedAt: null,
    storage: { CLAUDE_CONFIG_DIR: home },
    delivery: 'auto',
    config: { revision: 1, env: {}, args: '', instructions: null },
    conversations: [{ id: randomUUID(), startedAt: new Date().toISOString(), movedTo: null }],
  }))
  await changeRegistry(registry => void registry.sessions.push(...created))

  function startHost(session: SessionRecord) {
    // As the node does: the session's agent calls Outpost through this node.
    writeJson(statePath('bindings', `${session.id}.json`), { socket: nodeSocket })
    const host = new ChatHost(
      {
        socket: `chats/${session.id}.sock`,
        session: session.id,
        revision: session.config.revision,
        command: ['python3', fixture],
        cwd: directory,
        env: { ...cleanEnv(), CLAUDE_CONFIG_DIR: home, FIXTURE_ACP_VARIANT: 'claude' },
        resume: null,
        mcpServers: [
          {
            name: 'outpost',
            command: terminalBinary,
            args: ['mcp'],
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

  const connector: ChatConnector = (_context, sessionId, start, events) => {
    if (!hosts.has(sessionId)) {
      if (!start) {
        setImmediate(() => events.closed('The chat stopped.', 410))
        return { send() {}, close() {} }
      }
      startHost(created.find(item => item.id === sessionId)!)
    }
    const socket = connect(statePath('chats', `${sessionId}.sock`))
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
        if (message.type === 'result' && muted.has(sessionId)) continue
        events.message(message)
      }
    })
    const write = (message: ChatHostRequest) => {
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
  // Contexts carry a machine connection; nothing here opens it.
  const machines = new Machines('chat-harness')
  const resolve = targetResolver(deployment, machines, false)
  const owner = deployment.owner()
  /** The session list as the machine describes it, asking running chat hosts;
   * sessions named in `terminal` run in a terminal instead. */
  const inTerminal = new Set(options.terminal ?? [])
  const list = async () =>
    (await listSessions()).map(session =>
      inTerminal.has(session.name) ? { ...session, driver: 'terminal' as const, status: 'attached' as const } : session,
    )

  const hubs: ChatHub[] = []
  const received: ChatServerMessage[] = []
  /** Session files through the machine's own file store. */
  const files = {
    list: async (_context: unknown, sessionId: string) => listFiles(sessionId),
    receive: async (_context: unknown, sessionId: string, name: string, data: Buffer) => {
      const stored = new StoredFile(sessionId, name, 'received')
      stored.write(data)
      return stored.commit()
    },
    read: async (_context: unknown, sessionId: string, fileId: string) => {
      const { file, path } = storedFile(sessionId, fileId)
      return { file, bytes: readFileSync(path) }
    },
  }

  /** Messages for terminal sessions: what was handed to each, and its progress, which a test sets. */
  const typed: { session: string; key: string; text: string }[] = []
  const progress = new Map<string, TerminalDelivery>()
  const terminals = {
    async deliver(_context: unknown, session: string, key: string, text: string) {
      if (!progress.has(key)) {
        typed.push({ session, key, text })
        progress.set(key, { key, state: 'waiting', reply: null, error: null })
      }
      return progress.get(key)!
    },
    deliveries: async (_context: unknown, _session: string, keys: string[]) =>
      keys.flatMap(key => (progress.has(key) ? [progress.get(key)!] : [])),
  }

  /** The node's agent endpoint: agents' Outpost tool calls reach the open hub.
   * It exists only while a hub is connected, as a node lives with its connection. */
  let endpoint: Server | null = null
  async function serveAgents(hub: ChatHub) {
    endpoint = createServer(socket => {
      let data = ''
      socket.setEncoding('utf8')
      socket.on('error', () => {})
      socket.on('data', (chunk: string) => {
        data += chunk
        if (!data.includes('\n')) return
        const request = JSON.parse(data.slice(0, data.indexOf('\n')))
        hub.agent(owner, { targetId: target.id, sessionId: request.session }, request.tool, request.arguments).then(
          result => socket.end(`${JSON.stringify({ ok: true, data: result })}\n`),
          error => socket.end(`${JSON.stringify({ ok: false, message: (error as Error).message })}\n`),
        )
      })
    })
    await mkdir(statePath('run'), { recursive: true })
    await new Promise<void>(done => endpoint!.listen(statePath(nodeSocket), done))
  }

  async function startHub(timing: { promptMs?: number; probeMs?: number } = {}) {
    endpoint?.close()
    const hub = new ChatHub({
      deployment,
      resolve,
      list,
      files,
      terminals,
      connect: connector,
      terminalPollMs: 100,
      ...timing,
    })
    const close = hub.close.bind(hub)
    hub.close = () => {
      close()
      endpoint?.close()
      endpoint = null
    }
    hubs.push(hub)
    await hub.start()
    await serveAgents(hub)
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
    cutAfterPrompt,
    frozen,
    startHub,
    terminal: {
      typed,
      /** The terminal session's agent answered message `key`. */
      answer: (key: string, reply: string) => progress.set(key, { key, state: 'done', reply, error: null }),
    },
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
      machines.close()
      await pause(500)
      machineState.directory = previous
      await rm(directory, { recursive: true, force: true })
    },
  }
}

/** This process's environment without the binding of any session it runs in. */
function cleanEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('OUTPOST_'),
    ),
  )
}
