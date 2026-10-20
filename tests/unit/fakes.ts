import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { imageExtensions, imageProblem, type ImageMediaType } from '../../shared/images'
import type { Session, SessionForkInput, SessionInput, SessionList } from '../../shared/model'
import { AppError } from '../../backend/errors'
import type { SessionService, TargetContext } from '../../backend/sessions'
import type { SoftwareService } from '../../backend/software'

const relay = join(fileURLToPath(new URL('../fixtures/', import.meta.url)), 'fake_relay.py')

/** In-memory sessions per target; attach runs the fake relay fixture. */
export class FakeSessions implements SessionService {
  sessions = new Map<string, Session[]>()
  attached: { targetId: string; id: string; cols: number; rows: number }[] = []
  private all(context: TargetContext) {
    return this.sessions.get(context.target.id) ?? []
  }
  private find(context: TargetContext, id: string) {
    const session = this.all(context).find(item => item.id === id)
    if (!session) throw new AppError('Session not found', 404)
    return session
  }
  async list(context: TargetContext): Promise<SessionList> {
    return { sessions: this.all(context), registryPath: '/root/.outpost/registry.json' }
  }
  async get(context: TargetContext, id: string) {
    return this.find(context, id)
  }
  async create(context: TargetContext, input: SessionInput) {
    const session: Session = {
      id: crypto.randomUUID(),
      name: input.name,
      tool: input.tool,
      rootDir: input.rootDir,
      env: input.env ?? {},
      args: input.args ?? '',
      cliSessionId: crypto.randomUUID(),
      cliSessionEnv: {},
      createdAt: new Date().toISOString(),
      lastConnectedAt: null,
      status: 'ready',
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
  async acknowledge(context: TargetContext, id: string) {
    return this.find(context, id)
  }
  async fork(context: TargetContext, id: string, input: SessionForkInput) {
    const source = this.find(context, id)
    return this.create(context, {
      name: input.branch,
      rootDir: input.rootDir,
      tool: source.tool,
      env: source.env,
      args: source.args,
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
  attach(context: TargetContext, id: string, cols: number, rows: number) {
    this.attached.push({ targetId: context.target.id, id, cols, rows })
    return { executable: 'python3', args: [relay, `${cols}x${rows}`], label: 'Fake relay' }
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
