// `outpost-terminal chat-serve`: the persistent ACP client of one managed
// session. It owns the agent process, its prompt queue, the session journal and
// its activity, and serves viewers on a private Unix socket (docs/CHAT.md).
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { pathToFileURL } from 'node:url'
import * as acp from '@agentclientprotocol/sdk'
import type { SessionActivity } from '../shared/activity'
import {
  bounded,
  chatHost,
  ChatJournal,
  journalBlock,
  linkedFile,
  type ChatEntryInput,
  type ChatHostMessage,
  type ChatHostStatus,
  type ChatInfo,
  type ChatLaunch,
  type ChatOrigin,
} from '../shared/chatHost'
import { FrameDecoder, maxTerminalFrame, terminalControl } from '../shared/node/terminalFrames'
import { parseSessionFile, previewImage, sessionFileId } from '../shared/sessionFiles'
import { readActivity, saveActivity } from './activity'
import { changeRegistry, switchConversation } from './registry'
import { contentPath, filesDirectory, readFile } from './files'
import { socketAddress, statePath } from './state'
import { terminalService } from '../shared/terminalService'

const originKinds = new Set(['user', 'channel', 'session', 'reply', 'schedule'])
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function validLaunch(value: unknown): value is ChatLaunch {
  if (!record(value)) return false
  const launch = value as unknown as ChatLaunch
  return (
    typeof launch.socket === 'string' &&
    /^chats\/[a-f0-9-]{36}\.sock$/.test(launch.socket) &&
    typeof launch.session === 'string' &&
    /^[a-f0-9-]{36}$/.test(launch.session) &&
    Number.isInteger(launch.revision) &&
    Array.isArray(launch.command) &&
    launch.command.length > 0 &&
    launch.command.every(part => typeof part === 'string' && part.length > 0) &&
    typeof launch.cwd === 'string' &&
    launch.cwd.startsWith('/') &&
    record(launch.env) &&
    Object.values(launch.env).every(item => typeof item === 'string') &&
    (launch.resume === null || (typeof launch.resume === 'string' && launch.resume.length <= 256)) &&
    Array.isArray(launch.mcpServers) &&
    (launch.instructions === null || (typeof launch.instructions === 'string' && launch.instructions.length <= 32_000))
  )
}

function validOrigin(value: unknown): value is ChatOrigin {
  return record(value) && originKinds.has(value.kind as string) && JSON.stringify(value).length <= chatHost.maxOrigin
}

/** Prompt content from a viewer: bounded text blocks and session file IDs. */
function validPrompt(value: unknown, files: unknown): { text: acp.ContentBlock[]; files: string[] } | string {
  if (!Array.isArray(value) || value.length > 64) return 'Invalid message.'
  if (!Array.isArray(files) || !files.every(sessionFileId)) return 'Invalid attachments.'
  if (files.length > chatHost.maxFiles) return `Attach at most ${chatHost.maxFiles} files at once.`
  let text = 0
  for (const block of value) {
    if (!record(block) || block.type !== 'text' || typeof block.text !== 'string') return 'Invalid message.'
    text += block.text.length
  }
  if (text > 256 * 1024) return 'Messages must fit within 256 KiB of text.'
  if (text === 0 && files.length === 0) return 'Write a message first.'
  return { text: value as acp.ContentBlock[], files: [...new Set(files)] }
}

interface Queued {
  turn: string
  key: string | null
  origin: ChatOrigin
  prompt: acp.ContentBlock[]
}
interface Client {
  /** Said hello: a live connection that receives the journal. */
  greeted: boolean
  decoder: FrameDecoder
}
interface Pending {
  turn: string
  options: acp.PermissionOption[]
  resolve(optionId: string | null): void
}

interface ChatHostOptions {
  /** Called once the service has shut down; the executable exits here. */
  onExit?(code: number): void
  /** Overrides chatHost.idleMs (tests). */
  idleMs?: number
}

export class ChatHost {
  readonly journal = new ChatJournal()
  readonly instance = randomUUID()
  private info: ChatInfo
  private queue: Queued[] = []
  private keys = new Map<string, string>()
  private running: Queued | null = null
  private lastTurn: string | null = null
  private unseen: { turn: string; completionId: string } | null = null
  /** Completions the user has seen, kept with the session's saved activity. */
  private seen: string[]
  private lifecycle: acp.NewSessionRequest | null = null
  private failure: string | null = null
  private activityAt = new Date().toISOString()
  private permissions = new Map<string, Pending>()
  private clients = new Map<Socket, Client>()
  private server: Server | null = null
  private child: ChildProcess | null = null
  private connection: acp.ClientConnection | null = null
  private sessionId = ''
  private stderr = ''
  private ended = false
  private infoTimer: NodeJS.Timeout | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private loading = false
  /** This session's file store. */
  private files: string

  constructor(
    private launch: ChatLaunch,
    private options: ChatHostOptions = {},
  ) {
    this.files = filesDirectory(launch.session)
    this.seen = readActivity(launch.session)?.seen ?? []
    this.info = {
      state: 'starting',
      error: null,
      agent: null,
      nativeId: launch.resume,
      title: null,
      modes: null,
      config: [],
      commands: [],
      usage: null,
      images: false,
      instructions: 'none',
      activity: this.activity(),
    }
  }

  async start() {
    await this.listen()
    try {
      await this.open()
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error))
    }
  }

  // Agent --------------------------------------------------------------------------

  private async open() {
    const [command, ...args] = this.launch.command
    const child = spawn(command, args, { cwd: this.launch.cwd, env: this.launch.env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (text: string) => {
      this.stderr = (this.stderr + text).slice(-8192)
      process.stderr.write(text)
    })
    child.on('error', error => this.fail(`Could not start the coding tool: ${error.message}`))
    child.on('exit', (code, signal) => this.agentExited(code, signal))
    const output = new WritableStream<Uint8Array>({
      write: chunk =>
        new Promise((resolve, reject) => {
          if (!child.stdin!.writable) return reject(new Error('The coding tool closed its input.'))
          child.stdin!.write(chunk, error => (error ? reject(error) : resolve()))
        }),
      close: () => void child.stdin!.end(),
    })
    // The ACP connection may cancel the stream first during shutdown.
    let readable = true
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        const settle = (action: () => void) => {
          if (!readable) return
          readable = false
          action()
        }
        child.stdout!.on('data', (chunk: Buffer) => readable && controller.enqueue(new Uint8Array(chunk)))
        child.stdout!.on('end', () => settle(() => controller.close()))
        child.stdout!.on('error', error => settle(() => controller.error(error)))
      },
      cancel() {
        readable = false
        child.stdout!.destroy()
      },
    })
    const app = acp
      .client({ name: 'outpost' })
      .onNotification('session/update', ({ params }) => this.update(params.update))
      .onRequest('session/request_permission', ({ params }) => this.requestPermission(params))
    const connection = app.connect(acp.ndJsonStream(output, input))
    this.connection = connection
    const agent = connection.agent
    const initialized = await withTimeout(
      agent.request('initialize', {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          // Codex streams command output through this ACP extension.
          _meta: { terminal_output_delta: true },
        },
        clientInfo: { name: 'outpost', title: 'Outpost', version: terminalService.version },
      }),
      60_000,
      'The coding tool did not start its Agent Client Protocol server.',
    )
    const capabilities = initialized.agentCapabilities ?? {}
    const instructions = this.launch.instructions?.trim() || null
    const supportsInstructions = Boolean(capabilities.sessionCapabilities?.systemPrompt)
    this.info.agent = {
      name: initialized.agentInfo?.name ?? 'agent',
      title: initialized.agentInfo?.title ?? null,
      version: initialized.agentInfo?.version ?? null,
    }
    this.info.images = Boolean(capabilities.promptCapabilities?.image)
    this.info.instructions = !instructions ? 'none' : supportsInstructions ? 'applied' : 'unsupported'
    // Attachments live in the session's file store; let the agent's own tools read it.
    const directories = capabilities.sessionCapabilities?.additionalDirectories
    if (directories) mkdirSync(this.files, { recursive: true, mode: 0o700 })
    const lifecycle: acp.NewSessionRequest = (this.lifecycle = {
      cwd: this.launch.cwd,
      ...(directories ? { additionalDirectories: [this.files] } : {}),
      mcpServers: this.launch.mcpServers,
      ...(instructions && supportsInstructions
        ? { systemPrompt: { mode: 'append', content: [{ type: 'text', text: instructions }] } }
        : {}),
    })
    if (this.launch.resume) {
      if (!capabilities.loadSession) throw new Error('This coding tool cannot reopen conversations over ACP.')
      this.sessionId = this.launch.resume
      this.loading = true
      this.record({ kind: 'history', phase: 'begin' })
      try {
        const loaded = await agent.request('session/load', { ...lifecycle, sessionId: this.sessionId })
        this.info.modes = loaded.modes ?? null
        this.info.config = loaded.configOptions ?? []
      } finally {
        this.loading = false
        this.record({ kind: 'history', phase: 'end' })
      }
    } else {
      const created = await agent.request('session/new', lifecycle)
      this.sessionId = created.sessionId
      this.info.modes = created.modes ?? null
      this.info.config = created.configOptions ?? []
      this.info.nativeId = created.sessionId
      // The first prompt writes the native transcript. Its identity is saved
      // in the session's timeline first, or a restart would lose it.
      await this.recordConversation(created.sessionId)
    }
    if (instructions && !supportsInstructions)
      this.record({
        kind: 'notice',
        level: 'warning',
        turn: null,
        text: 'This coding tool does not support session instructions over ACP; they were not applied.',
      })
    this.info.nativeId = this.sessionId
    this.setState('ready')
    void connection.closed.then(() => {
      if (!this.ended) this.fail(this.exitMessage('The coding tool closed its connection.'))
    })
    this.pump()
  }

  /** The conversation is current in this session from now on. */
  private async recordConversation(conversation: string) {
    await changeRegistry(registry => switchConversation(registry, this.launch.session, conversation))
  }

  /** Start a new conversation in the same session, like /new in a terminal. */
  private async startNew() {
    const agent = this.connection!.agent
    const created = await agent.request('session/new', this.lifecycle!)
    await this.recordConversation(created.sessionId)
    this.sessionId = created.sessionId
    this.info.nativeId = created.sessionId
    this.info.modes = created.modes ?? null
    this.info.config = created.configOptions ?? []
    this.info.title = null
    this.unseen = null
    this.failure = null
    this.record({ kind: 'notice', level: 'info', turn: null, text: 'Started a new conversation.' })
    this.activityChanged()
    this.infoChanged(true)
  }

  private exitMessage(fallback: string) {
    const tail = this.stderr.trim().split('\n').slice(-3).join('\n').trim()
    return tail ? `${fallback} ${tail}`.slice(0, 2000) : fallback
  }

  private agentExited(code: number | null, signal: NodeJS.Signals | null) {
    if (this.ended) return
    const how = signal ? `was stopped by ${signal}` : `exited with status ${code}`
    this.fail(this.exitMessage(`The coding tool ${how}.`))
  }

  private fail(message: string) {
    if (this.ended) return
    // The target runtime reports this log tail when no viewer saw the failure.
    process.stderr.write(`outpost: ${message}\n`)
    this.failure = message
    this.info.error = message
    this.endRunning('error', message)
    for (const item of this.queue.splice(0)) this.record({ kind: 'unqueued', turn: item.turn })
    this.record({ kind: 'notice', level: 'error', turn: null, text: message })
    this.setState(this.info.state === 'ready' ? 'exited' : 'failed')
    this.shutdown(1)
  }

  // Updates and permissions ----------------------------------------------------------

  private update(update: acp.SessionUpdate) {
    switch (update.sessionUpdate) {
      case 'available_commands_update':
        this.info.commands = bounded(update.availableCommands) as acp.AvailableCommand[]
        return this.infoChanged()
      case 'current_mode_update':
        if (this.info.modes) this.info.modes = { ...this.info.modes, currentModeId: update.currentModeId }
        return this.infoChanged()
      case 'config_option_update':
        this.info.config = bounded(update.configOptions) as acp.SessionConfigOption[]
        return this.infoChanged()
      case 'session_info_update':
        if (update.title !== undefined) this.info.title = update.title?.slice(0, 200) ?? null
        return this.infoChanged()
      case 'usage_update':
        this.info.usage = { used: update.used, size: update.size, cost: update.cost ?? null }
        return this.infoChanged()
    }
    // Live turns own their updates. Replayed history and stray updates between
    // turns belong to no turn.
    const turn = this.loading ? null : (this.running?.turn ?? null)
    this.record({ kind: 'update', turn, update: kept(update) })
  }

  private requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const turn = this.running?.turn ?? this.lastTurn
    if (!turn) return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    const id = randomUUID()
    const options = params.options.slice(0, 16).map(option => bounded(option) as acp.PermissionOption)
    return new Promise(resolve => {
      this.permissions.set(id, {
        turn,
        options,
        resolve: optionId => {
          this.permissions.delete(id)
          this.record({ kind: 'resolved', turn, id, optionId })
          this.activityChanged()
          resolve(optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } })
        },
      })
      this.record({ kind: 'permission', turn, id, toolCall: bounded(params.toolCall) as acp.ToolCallUpdate, options })
      this.activityChanged()
    })
  }

  // Turns ---------------------------------------------------------------------------

  private enqueue(key: string | null, origin: ChatOrigin, prompt: acp.ContentBlock[]) {
    if (key && this.keys.has(key)) return { turn: this.keys.get(key)!, duplicate: true }
    if (this.queue.length >= chatHost.maxQueue) throw new Error('Too many queued messages. Wait for the current ones.')
    const turn = randomUUID()
    if (key) {
      this.keys.set(key, turn)
      if (this.keys.size > 1024) this.keys.delete(this.keys.keys().next().value!)
    }
    this.queue.push({ turn, key, origin, prompt })
    this.record({ kind: 'queued', turn, key, origin, prompt: prompt.map(journalBlock) })
    this.activityChanged()
    this.pump()
    return { turn, duplicate: false }
  }

  private pump() {
    if (this.running || this.info.state !== 'ready' || !this.connection || this.ended) return
    const next = this.queue.shift()
    if (!next) return
    this.running = next
    this.lastTurn = next.turn
    this.record({ kind: 'started', turn: next.turn })
    this.activityChanged()
    const agent = this.connection.agent
    agent.request('session/prompt', { sessionId: this.sessionId, prompt: this.inline(next.prompt) }).then(
      result => this.finish(next.turn, result.stopReason, null),
      error => this.finish(next.turn, 'error', describeError(error)),
    )
  }

  // Files ---------------------------------------------------------------------------

  /** A resource link to one stored session file, which the agent reads with its own tools. */
  private link(id: string): acp.ContentBlock {
    let stored: ReturnType<typeof readFile>
    try {
      stored = readFile(this.launch.session, id)
    } catch {
      throw new Error('An attached file is no longer in this session. Attach it again.')
    }
    const { file, path } = stored
    return {
      type: 'resource_link',
      name: file.name,
      uri: pathToFileURL(path).href,
      size: file.size,
      ...(previewImage(file) ? { mimeType: file.mediaType } : {}),
      _meta: { outpost: { file } },
    }
  }

  /** Images also go inline when the agent accepts them, read when the turn starts. */
  private inline(prompt: acp.ContentBlock[]): acp.ContentBlock[] {
    if (!this.info.images) return prompt
    return prompt.flatMap(block => {
      const file = linkedFile(block)
      if (!file || !previewImage(file) || file.size > chatHost.maxImageBytes) return [block]
      try {
        const data = readFileSync(contentPath(this.launch.session, file)).toString('base64')
        return [{ type: 'image', mimeType: file.mediaType, data } as acp.ContentBlock, block]
      } catch {
        return [block] // Removed since; the agent finds the link's file missing.
      }
    })
  }

  private finish(turn: string, stopReason: acp.StopReason | 'error', error: string | null) {
    if (this.running?.turn !== turn) return
    this.endRunning(stopReason, error)
    this.pump()
  }

  private endRunning(stopReason: acp.StopReason | 'error', error: string | null) {
    const running = this.running
    if (!running) return
    this.running = null
    for (const pending of [...this.permissions.values()]) if (pending.turn === running.turn) pending.resolve(null)
    this.record({ kind: 'ended', turn: running.turn, stopReason, error })
    if (stopReason !== 'cancelled' && running.origin.kind !== 'channel')
      this.unseen = {
        turn: running.turn,
        completionId: createHash('sha256').update(`${this.launch.session}:${running.turn}`).digest('hex'),
      }
    this.failure = stopReason === 'error' ? error : null
    this.activityChanged()
  }

  // Activity and info ------------------------------------------------------------------

  private activity(): SessionActivity {
    const at = this.activityAt
    const base = { updatedAt: at, observedAt: at, observation: 'current' as const, completionId: null, detail: null }
    if (this.info?.state === 'failed' || (this.info?.state === 'exited' && this.info.error))
      return { ...base, state: 'error', detail: this.info.error }
    if (this.info?.state === 'exited') return { ...base, state: 'idle' }
    if (this.permissions.size) return { ...base, state: 'waiting', detail: 'Waiting for your approval' }
    if (this.running || this.queue.length) return { ...base, state: 'working' }
    // The last turn's error remains until another turn starts.
    if (this.failure) return { ...base, state: 'error', detail: this.failure }
    if (this.unseen) return { ...base, state: 'finished', completionId: this.unseen.completionId }
    return { ...base, state: 'idle' }
  }

  /** Nothing to do and nobody watching. An unseen reply keeps the host, so its
   * badge stays; other results are already recorded in channels and schedules. */
  private resting() {
    const state = this.info.activity.state
    return (
      this.info.state === 'ready' &&
      (state === 'idle' || state === 'error') &&
      ![...this.clients.values()].some(client => client.greeted)
    )
  }

  private scheduleRest() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (this.ended || !this.resting()) return
    const idleMs = this.options.idleMs ?? chatHost.idleMs
    this.idleTimer = setTimeout(() => {
      if (!this.resting()) return
      process.stderr.write('outpost: stopped while idle with no viewers\n')
      this.stop()
    }, idleMs).unref()
  }

  private activityChanged() {
    const next = this.activity()
    const previous = this.info.activity
    if (next.state === previous.state && next.completionId === previous.completionId && next.detail === previous.detail)
      return
    this.activityAt = new Date().toISOString()
    this.info.activity = this.activity()
    this.saveActivity()
    this.infoChanged(true)
    this.scheduleRest()
  }

  private setState(state: ChatInfo['state']) {
    this.info.state = state
    this.info.activity = this.activity()
    this.saveActivity()
    this.infoChanged(true)
    this.scheduleRest()
  }

  /** Kept after the host stops, so an unread reply is still reported. */
  private saveActivity() {
    try {
      saveActivity(this.launch.session, {
        conversation: this.sessionId || (this.launch.resume ?? ''),
        last: this.info.activity,
        seen: this.seen,
      })
    } catch {
      /* Derived state; the next change saves again. */
    }
  }

  /** Usage and command updates can arrive per token; coalesce their broadcasts.
   * State, activity and setting changes are sent at once. */
  private infoChanged(now = false) {
    if (now) {
      if (this.infoTimer) clearTimeout(this.infoTimer)
      this.infoTimer = null
      return this.broadcast({ type: 'info', info: this.info })
    }
    this.infoTimer ??= setTimeout(() => {
      this.infoTimer = null
      this.broadcast({ type: 'info', info: this.info })
    }, 1000)
  }

  /** Acknowledge only the displayed completion; a newer one stays unread. */
  private markSeen(completionId: unknown) {
    if (!this.unseen || this.unseen.completionId !== completionId) return
    this.seen = [...this.seen, this.unseen.completionId].slice(-64)
    this.unseen = null
    this.activityChanged()
  }

  status(): ChatHostStatus {
    return {
      type: 'status',
      version: terminalService.version,
      protocol: chatHost.protocol,
      pid: process.pid,
      revision: this.launch.revision,
      clients: [...this.clients.values()].filter(client => client.greeted).length,
      state: this.info.state,
      nativeId: this.info.nativeId,
      activity: this.info.activity,
    }
  }

  // Viewers -------------------------------------------------------------------------

  private record(input: ChatEntryInput) {
    const entry = this.journal.record(input)
    this.broadcast({ type: 'entry', entry })
    return entry
  }

  private send(socket: Socket, message: ChatHostMessage) {
    if (socket.destroyed || socket.writableEnded) return
    const payload = Buffer.from(JSON.stringify(message))
    if (payload.length > maxTerminalFrame) {
      socket.end(terminalControl({ type: 'error', message: 'This conversation is too large to send.' }))
      return
    }
    // A viewer that stops reading must resynchronize instead of growing memory.
    if (socket.writableLength > 64 * 1024 * 1024) return void socket.destroy()
    socket.write(terminalControl(message))
  }

  private broadcast(message: ChatHostMessage) {
    for (const [socket, client] of this.clients) if (client.greeted) this.send(socket, message)
  }

  private async listen() {
    const server = createServer(socket => this.accept(socket))
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketAddress(this.launch.socket), () => {
        chmodSync(statePath(this.launch.socket), 0o600)
        resolve()
      })
    })
  }

  private accept(socket: Socket) {
    const client: Client = { greeted: false, decoder: new FrameDecoder() }
    this.clients.set(socket, client)
    socket.setTimeout(10_000, () => {
      if (!client.greeted) socket.destroy()
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      this.clients.delete(socket)
      this.scheduleRest()
    })
    socket.on('data', bytes => {
      try {
        for (const frame of client.decoder.feed(Buffer.from(bytes))) {
          if (frame.kind !== 'C') throw new Error('Invalid chat frame')
          this.request(socket, client, JSON.parse(frame.payload.toString('utf8')))
        }
      } catch (error) {
        this.send(socket, { type: 'error', message: (error as Error).message })
        socket.end()
      }
    })
  }

  private reply(socket: Socket, id: string, ok: boolean, message?: string, data?: unknown) {
    this.send(socket, {
      type: 'result',
      id,
      ok,
      ...(message ? { message } : {}),
      ...(data !== undefined ? { data } : {}),
    })
  }

  private request(socket: Socket, client: Client, message: Record<string, unknown>) {
    if (!record(message) || typeof message.type !== 'string') throw new Error('Invalid chat request')
    if (!client.greeted) {
      // One-shot requests from the node and the MCP server need no journal.
      if (message.type === 'status') {
        socket.end(terminalControl(this.status()))
        return
      }
      if (message.type === 'seen') {
        this.markSeen(message.completionId)
        socket.end(terminalControl(this.status()))
        return
      }
      if (message.type === 'stop') {
        socket.end(terminalControl({ type: 'result', ok: true }))
        this.stop()
        return
      }
      if (message.type === 'file') {
        // Stored on the target already; this only places it in the transcript.
        const file = parseSessionFile(message.file)
        this.record({ kind: 'file', turn: this.running?.turn ?? null, file })
        socket.end()
        return
      }
      if (message.type !== 'hello') throw new Error('Say hello first')
      if (message.protocol !== chatHost.protocol)
        throw new Error('Chat host protocol mismatch; install the current Outpost Terminal and restart this chat')
      client.greeted = true
      socket.setTimeout(0)
      this.send(socket, {
        type: 'welcome',
        protocol: chatHost.protocol,
        instance: this.instance,
        info: this.info,
        journal: this.journal.snapshot(),
      })
      this.scheduleRest()
      return
    }
    const id = message.id
    switch (message.type) {
      case 'ping':
        if (identifier(id)) this.reply(socket, id, true)
        return
    }
    if (!identifier(id)) throw new Error('A chat request ID is required')
    const fail = (text: string) => this.reply(socket, id, false, text)
    switch (message.type) {
      case 'prompt': {
        if (this.ended || this.info.state === 'failed' || this.info.state === 'exited')
          return fail('This chat has stopped. Open it again to restart the coding tool.')
        const key = message.key
        if (key !== null && !identifier(key)) return fail('Invalid message key.')
        if (!validOrigin(message.origin)) return fail('Invalid message origin.')
        const prompt = validPrompt(message.prompt, message.files)
        if (typeof prompt === 'string') return fail(prompt)
        try {
          const content = [...prompt.text, ...prompt.files.map(file => this.link(file))]
          return this.reply(socket, id, true, undefined, this.enqueue(key, message.origin, content))
        } catch (error) {
          return fail((error as Error).message)
        }
      }
      case 'cancel':
        if (!this.running || !this.connection) return fail('Nothing is running.')
        void this.connection.agent.notify('session/cancel', { sessionId: this.sessionId })
        for (const pending of [...this.permissions.values()])
          if (pending.turn === this.running.turn) pending.resolve(null)
        return this.reply(socket, id, true)
      case 'unqueue': {
        const index = this.queue.findIndex(item => item.turn === message.turn)
        if (index < 0) return fail('This message already started.')
        const [removed] = this.queue.splice(index, 1)
        if (removed.key) this.keys.delete(removed.key)
        this.record({ kind: 'unqueued', turn: removed.turn })
        this.activityChanged()
        return this.reply(socket, id, true)
      }
      case 'permission': {
        const pending = typeof message.request === 'string' ? this.permissions.get(message.request) : undefined
        if (!pending) return fail('This request was already answered.')
        const optionId = message.optionId
        if (optionId !== null && !pending.options.some(option => option.optionId === optionId))
          return fail('Choose one of the offered options.')
        pending.resolve(optionId as string | null)
        return this.reply(socket, id, true)
      }
      case 'config': {
        if (!this.connection || this.info.state !== 'ready') return fail('The coding tool is not ready.')
        if (typeof message.configId !== 'string' || !['string', 'boolean'].includes(typeof message.value))
          return fail('Invalid setting.')
        const params: acp.SetSessionConfigOptionRequest =
          typeof message.value === 'boolean'
            ? { sessionId: this.sessionId, configId: message.configId, type: 'boolean' as const, value: message.value }
            : { sessionId: this.sessionId, configId: message.configId, value: message.value as string }
        this.connection.agent.request('session/set_config_option', params).then(
          result => {
            this.info.config = bounded(result.configOptions) as acp.SessionConfigOption[]
            this.infoChanged(true)
            this.reply(socket, id, true)
          },
          error => fail(describeError(error)),
        )
        return
      }
      case 'mode': {
        if (!this.connection || this.info.state !== 'ready') return fail('The coding tool is not ready.')
        if (typeof message.modeId !== 'string') return fail('Invalid mode.')
        const modeId = message.modeId
        this.connection.agent.request('session/set_mode', { sessionId: this.sessionId, modeId }).then(
          () => {
            if (this.info.modes) this.info.modes = { ...this.info.modes, currentModeId: modeId }
            this.infoChanged(true)
            this.reply(socket, id, true)
          },
          error => fail(describeError(error)),
        )
        return
      }
      case 'seen':
        this.markSeen(message.completionId)
        return this.reply(socket, id, true)
      case 'new':
        if (!this.connection || this.info.state !== 'ready') return fail('The coding tool is not ready.')
        if (this.running || this.queue.length) return fail('Wait for the current messages to finish first.')
        this.startNew().then(
          () => this.reply(socket, id, true),
          error => fail(describeError(error)),
        )
        return
      case 'note': {
        const level = ['info', 'warning', 'error'].includes(message.level as string)
          ? (message.level as 'info')
          : 'info'
        if (typeof message.text !== 'string' || !message.text.trim()) return fail('Invalid note.')
        this.record({ kind: 'notice', level, turn: null, text: message.text.slice(0, 4096) })
        return this.reply(socket, id, true)
      }
      default:
        throw new Error('Unknown chat request')
    }
  }

  // Shutdown ------------------------------------------------------------------------

  /** Stop the agent; viewers receive the final entries before the socket closes. */
  stop() {
    if (this.ended) return
    this.child?.kill('SIGTERM')
    this.endRunning('cancelled', null)
    this.setState('exited')
    this.shutdown(0)
  }

  private shutdown(code: number) {
    if (this.ended) return
    this.ended = true
    if (this.infoTimer) clearTimeout(this.infoTimer)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.broadcast({ type: 'info', info: this.info })
    this.server?.close()
    try {
      unlinkSync(statePath(this.launch.socket))
    } catch {
      /* Already removed. */
    }
    for (const socket of this.clients.keys()) socket.end()
    const child = this.child
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 3000).unref()
    }
    this.connection?.close()
    setTimeout(() => this.options.onExit?.(code), 200).unref()
  }
}

/** The journaled form of an agent update: message text as sent, images the
 * agent produced up to the image limit, and bounded tool reports. */
function kept(update: acp.SessionUpdate): acp.SessionUpdate {
  if (update.sessionUpdate === 'agent_thought_chunk') return update
  if (update.sessionUpdate === 'user_message_chunk' || update.sessionUpdate === 'agent_message_chunk') {
    const block = update.content
    const keep =
      block.type === 'text' ||
      (update.sessionUpdate === 'agent_message_chunk' &&
        block.type === 'image' &&
        block.data.length <= chatHost.maxImageBytes)
    return keep ? update : { ...update, content: journalBlock(block) }
  }
  return bounded(update) as acp.SessionUpdate
}

function describeError(error: unknown) {
  if (error instanceof acp.RequestError) {
    const details = record(error.data) && typeof error.data.details === 'string' ? `: ${error.data.details}` : ''
    if (error.code === -32000) return `Sign in to this coding tool on the target first${details}`
    return `${error.message}${details}`.slice(0, 2000)
  }
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000)
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** Entry point: configuration arrives on stdin, never argv or a file. */
export async function serveChat() {
  process.umask(0o077)
  let config = ''
  for await (const chunk of process.stdin) {
    config += chunk.toString()
    if (config.length > 1024 * 1024) throw new Error('Launch configuration is too large')
  }
  const launch: unknown = JSON.parse(config)
  if (!validLaunch(launch)) throw new Error('Invalid chat configuration')
  const host = new ChatHost(launch, { onExit: code => process.exit(code) })
  process.on('SIGHUP', () => {}) // SSH/client lifetime never owns this process.
  process.on('SIGTERM', () => host.stop())
  process.on('SIGINT', () => host.stop())
  await host.start()
}
