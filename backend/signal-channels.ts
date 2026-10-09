import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import type { Target } from '../shared/session-manager'
import type { SignalEnvironment } from '../shared/signals'
import { transportFor } from './transport'
import { supportingPath, quote } from './shell'
import { AppError } from './errors'

const relay = deflateSync(readFileSync(new URL('./signal-relay.py', import.meta.url))).toString('base64')
const client = readFileSync(new URL('./signal-client.py', import.meta.url), 'utf8')
interface Setup { scope: string; token: string }
type Dispatch = (token: string, body: unknown) => Promise<unknown>
interface Pending { resolve: (environment: SignalEnvironment) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

/** One duplex process per target, using the same SSH configuration/account key
 * or WSL identity as session management. No public callback port is required. */
class SignalChannel {
  private child: ChildProcessWithoutNullStreams | null = null
  private starting: Promise<void> | null = null
  private stopped = false
  private retry?: NodeJS.Timeout
  private sessions = new Map<string, string>()
  private pending = new Map<string, Pending>()
  constructor(private target: Target, private scope: string, private dispatch: Dispatch, private env: NodeJS.ProcessEnv, private accountIdentity: boolean) {}
  private send(value: unknown) {
    if (this.stopped || !this.child || this.child.killed || this.child.stdin.destroyed || this.child.stdin.writableLength > 256 * 1024) throw new AppError('Signal connection is unavailable. Reconnect the session.', 503)
    this.child.stdin.write(JSON.stringify(value) + '\n')
  }
  private configure(sessionId: string, token: string): Promise<SignalEnvironment> {
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const child = this.child
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new AppError('Signal setup timed out.', 504))
        // A live but unresponsive receiver must not poison future attachments.
        if (this.child === child) child?.kill('SIGKILL')
      }, 10_000).unref()
      this.pending.set(id, { resolve, reject, timer })
      try { this.send({ kind: 'configure', id, sessionId, token }) }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }
  private start() {
    if (this.stopped) return Promise.reject(new AppError('Outpost is closing.', 503))
    if (this.starting) return this.starting
    clearTimeout(this.retry)
    const restore = [...this.sessions.keys()]
    const transport = transportFor(this.target, this.accountIdentity), command = transport.script()
    const context = transport.context ?? (this.target.environment ? { home: this.target.environment.home, uid: this.target.environment.uid } : undefined)
    const settings = Buffer.from(JSON.stringify({ scope: this.scope, client, context })).toString('base64')
    const program = `import base64,zlib;exec(zlib.decompress(base64.b64decode('${relay}')))`
    const child = spawn(command.executable, command.args, { stdio: ['pipe', 'pipe', 'pipe'], env: this.env, windowsHide: true })
    this.child = child
    let ready = false, buffer = ''
    this.starting = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new AppError('Signal connection timed out.', 504)); child.kill() }, 25_000).unref()
      child.stdin.on('error', () => {})
      child.stderr.resume() // Do not log remote startup text or credentials.
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk
        if (buffer.length > 256 * 1024) { child.kill(); return }
        let end
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
          if (!line.startsWith('OUTPOST_SIGNAL:')) continue
          try {
            const event = JSON.parse(line.slice('OUTPOST_SIGNAL:'.length))
            if (event.kind === 'ready' && !ready) { ready = true; clearTimeout(timer); resolve() }
            else if (event.kind === 'configured') {
              const pending = this.pending.get(event.id)
              if (pending) { clearTimeout(pending.timer); this.pending.delete(event.id); pending.resolve(event.environment) }
            } else if (event.kind === 'signal' && typeof event.id === 'string') {
              const respond = (status: number, body: unknown) => {
                if (this.child === child && !this.stopped) { try { this.send({ kind: 'response', id: event.id, status, body }) } catch { /* transport closed */ } }
              }
              if (![...this.sessions.values()].includes(event.token)) { respond(401, { message: 'Invalid Outpost session token.' }); continue }
              void this.dispatch(event.token, event.body).then(result => respond(200, result), error => respond(error instanceof AppError ? error.statusCode : 502, { message: error instanceof AppError ? error.message : 'The signal listener could not handle this request.' }))
            }
          } catch { child.kill(); return }
        }
      })
      child.once('error', () => { clearTimeout(timer); reject(new AppError('Could not start the target signal connection.', 502)) })
      child.once('close', () => {
        clearTimeout(timer)
        reject(new AppError('The target signal connection ended.', 503))
        if (this.child !== child) return
        this.child = null; this.starting = null
        for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new AppError('The target signal connection ended.', 503)) }
        this.pending.clear()
        if (!this.stopped) this.retry = setTimeout(() => { void this.start().catch(() => {}) }, 3000).unref()
      })
      child.stdin.write(`${supportingPath}; exec python3 -u -c ${quote(program)} ${quote(settings)}\n`)
    })
    this.starting = this.starting.then(async () => {
      for (const id of restore) {
        const token = this.sessions.get(id)
        if (token) await this.configure(id, token)
      }
    })
    return this.starting
  }
  async prepare(id: string, token: string) {
    if (this.sessions.size >= 256 && !this.sessions.has(id)) throw new AppError('Too many signal sessions on this target.', 429)
    const starting = this.start()
    this.sessions.set(id, token)
    await starting
    return this.configure(id, token)
  }
  forget(id: string) { this.sessions.delete(id) }
  retain(valid: (token: string) => boolean) { for (const [id, token] of this.sessions) if (!valid(token)) this.sessions.delete(id) }
  get empty() { return this.sessions.size === 0 }
  close() {
    this.stopped = true; clearTimeout(this.retry)
    this.child?.stdin.end()
    const child = this.child
    if (child) {
      const deadline = setTimeout(() => child.kill(), 1000).unref()
      child.once('close', () => clearTimeout(deadline))
    }
  }
}

export class SignalChannels {
  private channels = new Map<string, SignalChannel>()
  private cleanup?: NodeJS.Timeout
  private stopped = false
  constructor(private dispatch: Dispatch, private env = process.env, private accountIdentity = false, validToken?: (token: string) => boolean) {
    if (validToken) this.cleanup = setInterval(() => {
      for (const [scope, channel] of this.channels) { channel.retain(validToken); if (channel.empty) this.closeTarget(scope) }
    }, 5000).unref()
  }
  async prepare(target: Target, sessionId: string, setup: Setup) {
    if (this.stopped) throw new AppError('Outpost is closing.', 503)
    let channel = this.channels.get(setup.scope)
    if (!channel) {
      if (this.channels.size >= 256) throw new AppError('Too many signal connections.', 429)
      channel = new SignalChannel(target, setup.scope, this.dispatch, this.env, this.accountIdentity)
      this.channels.set(setup.scope, channel)
    }
    return channel.prepare(sessionId, setup.token)
  }
  closeTarget(scope: string) { this.channels.get(scope)?.close(); this.channels.delete(scope) }
  forget(scope: string, sessionId: string) {
    const channel = this.channels.get(scope)
    channel?.forget(sessionId)
    if (channel?.empty) this.closeTarget(scope)
  }
  close() { this.stopped = true; clearInterval(this.cleanup); for (const channel of this.channels.values()) channel.close(); this.channels.clear() }
}
