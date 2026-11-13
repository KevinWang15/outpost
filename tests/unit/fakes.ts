import { imageExtensions, imageProblem, type ImageMediaType } from '../../shared/images'
import type { Session, SessionForkInput, SessionInput, SessionUpdate } from '../../shared/model'
import { FrameDecoder, terminalControl, terminalFrame } from '../../shared/node/terminalFrames'
import { AppError } from '../../backend/errors'
import type { MachineError, Stream } from '../../backend/machines'
import type { SessionService, TargetContext } from '../../backend/sessions'
import type { SoftwareService } from '../../backend/software'

/** A terminal stream speaking the terminal service protocol: it echoes input,
 * reports resizes, answers pastes and sends a signal for 'signal:<url>'. */
class FakeTerminal implements Stream {
  readonly opened = null
  private decoder = new FrameDecoder()
  private pending: Buffer[] = []
  private data: ((bytes: Buffer) => void) | null = null
  private close: ((error: MachineError | null, data: unknown) => void) | null = null
  private ended = false

  constructor(size: string) {
    this.emit(terminalControl({ type: 'ready' }))
    this.output(`started ${size}`)
  }
  private emit(frame: Buffer) {
    if (this.data) this.data(frame)
    else this.pending.push(frame)
  }
  private output(text: string) {
    this.emit(terminalFrame('O', Buffer.from(text)))
  }
  onData(listener: (bytes: Buffer) => void) {
    this.data = listener
    for (const frame of this.pending.splice(0)) listener(frame)
  }
  onClose(listener: (error: MachineError | null, data: unknown) => void) {
    this.close = listener
  }
  write(bytes: Buffer) {
    for (const { kind, payload } of this.decoder.feed(bytes)) {
      if (kind === 'I') {
        const text = payload.toString()
        if (text.startsWith('signal:'))
          this.emit(
            terminalControl({
              type: 'signal',
              id: 's1',
              signal: { type: 'browser.open', payload: { url: text.slice(7) } },
            }),
          )
        else if (text === 'exit') {
          this.emit(terminalControl({ type: 'exit', reason: 'ended' }))
          this.end()
        } else this.output(`echo:${text}`)
        continue
      }
      const message = JSON.parse(payload.toString())
      if (message.type === 'resize') this.output(`size:${message.cols}x${message.rows}`)
      else if (message.type === 'ping') this.emit(terminalControl({ type: 'result', id: message.id, ok: true }))
      else if (message.type === 'send' || message.type === 'paste') {
        this.output(`echo:${message.data}`)
        this.emit(terminalControl({ type: 'result', id: message.id, ok: true }))
      } else if (message.type === 'signal-result') this.output(`signal-result:${JSON.stringify(message.ok)}`)
    }
  }
  end() {
    if (this.ended) return
    this.ended = true
    setImmediate(() => this.close?.(null, null))
  }
  pause() {}
  resume() {}
}

/** In-memory sessions per target; attach opens a fake terminal stream. */
export class FakeSessions implements SessionService {
  sessions = new Map<string, Session[]>()
  attached: { targetId: string; id: string; cols: number; rows: number }[] = []
  /** Attaching fails as a machine without the session would. */
  failAttach = false
  private all(context: TargetContext) {
    return this.sessions.get(context.target.id) ?? []
  }
  private find(context: TargetContext, id: string) {
    const session = this.all(context).find(item => item.id === id)
    if (!session) throw new AppError('Session not found', 404)
    return session
  }
  async list(context: TargetContext) {
    return { sessions: this.all(context) }
  }
  async get(context: TargetContext, id: string) {
    return this.find(context, id)
  }
  async create(context: TargetContext, input: SessionInput) {
    const now = new Date().toISOString()
    const session: Session = {
      id: crypto.randomUUID(),
      name: input.name,
      tool: input.tool,
      rootDir: input.rootDir,
      createdAt: now,
      lastConnectedAt: null,
      storage: input.storage ?? { CLAUDE_CONFIG_DIR: '/home/dev/.claude' },
      config: { revision: 1, env: input.env ?? {}, args: input.args ?? '', instructions: input.instructions ?? null },
      conversations: [{ id: input.conversation ?? crypto.randomUUID(), title: '', startedAt: now, movedTo: null }],
      title: '',
      status: 'ready',
      driver: null,
      runningRevision: null,
      activity: {
        state: 'idle',
        updatedAt: null,
        completionId: null,
        detail: null,
        observation: 'current',
        observedAt: null,
      },
    }
    this.sessions.set(context.target.id, [...this.all(context), session])
    return session
  }
  async update(context: TargetContext, id: string, update: SessionUpdate) {
    const session = this.find(context, id)
    if (update.revision !== session.config.revision) throw new AppError('The session changed since.', 409)
    const { revision, name, ...config } = update
    if (name) session.name = name
    if (Object.keys(config).length) session.config = { ...session.config, ...config, revision: revision + 1 }
    return session
  }
  async switch(context: TargetContext, id: string) {
    return this.find(context, id)
  }
  async acknowledge(context: TargetContext, id: string) {
    return this.find(context, id)
  }
  async fork(context: TargetContext, id: string, input: SessionForkInput) {
    const source = this.find(context, id)
    return this.create(context, {
      name: input.branch,
      rootDir: input.rootDir,
      tool: source.tool,
      env: source.config.env,
      args: source.config.args,
    })
  }
  async terminate(context: TargetContext, id: string) {
    return { ...this.find(context, id), status: 'stopped' as const }
  }
  async remove(context: TargetContext, id: string) {
    this.find(context, id)
    this.sessions.set(
      context.target.id,
      this.all(context).filter(item => item.id !== id),
    )
  }
  async uploadImage(context: TargetContext, id: string, data: Buffer, type: ImageMediaType, signal: AbortSignal) {
    signal.throwIfAborted()
    this.find(context, id)
    const problem = imageProblem({ type, size: data.length })
    if (problem) throw new AppError(problem, 400)
    const path = '/x.' + imageExtensions[type]
    return { path, reference: path }
  }
  async directories() {
    return { directories: [], truncated: false }
  }
  async search() {
    return { sessions: [], truncated: false, warnings: [] }
  }
  async attach(context: TargetContext, id: string, cols: number, rows: number): Promise<Stream> {
    this.attached.push({ targetId: context.target.id, id, cols, rows })
    if (this.failAttach) throw new AppError('Session not found', 404)
    return new FakeTerminal(`${cols}x${rows}`)
  }
  chatAttach(): never {
    throw new AppError('Chat is not available in this test.', 409)
  }
}

export const fakeSoftware: SoftwareService = {
  async inspect() {
    return {
      environment: { home: '/root', username: 'root', uid: 0, shell: '/bin/bash' },
      checkedAt: new Date().toISOString(),
      software: [],
    }
  },
  async install() {
    return 0
  },
}
