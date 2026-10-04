import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import ssh2, { type Client, type ClientChannel, type ServerHostKeyAlgorithm } from 'ssh2'
import headless, { type ITerminalAddon } from '@xterm/headless'
import serialize from '@xterm/addon-serialize'
import { WebSocket } from 'ws'
import type { SshTarget } from '../shared/session-manager'
import type { TerminalKeySource, WebTerminalInfo } from '../shared/web-terminal'
import { AppError } from './errors'
import { quote } from './shell'
import { sessionAttachOperation } from './sessions'
import type { TerminalKeys } from './terminal-keys'
import { managedSshIdentity } from './account-ssh'

export interface TerminalOwner { userId: string; authSessionId: string }
const sameOwner = (a: TerminalOwner, b: TerminalOwner) => a.userId === b.userId && a.authSessionId === b.authSessionId
const HIGH_WATER = 128 * 1024
interface HeldTerminal {
  id: string; owner: TerminalOwner; targetId: string; sessionId: string; keySource: TerminalKeySource
  client: Client; channel: ClientChannel | null; screen: InstanceType<typeof headless.Terminal>
  serializer: InstanceType<typeof serialize.SerializeAddon>; socket: WebSocket | null
  disconnectedAt: number; unacked: number; pending: number; replaying: boolean; alive: boolean; pong: boolean; blockedInput: boolean
}
export class WebTerminals {
  private entries = new Map<string, HeldTerminal>()
  private queues = new Map<string, Promise<void>>()
  private stopped = false
  private starts = new Map<string, { count: number; until: number }>()
  private cleanup: NodeJS.Timeout
  constructor(private keys: TerminalKeys, private validOwner: (owner: TerminalOwner) => boolean = () => true, private graceMs = 10 * 60_000) {
    this.cleanup = setInterval(() => {
      for (const entry of this.entries.values()) {
        if (!this.validOwner(entry.owner)) this.finish(entry, 'Sign-in ended. Sign in again to reconnect.')
        else if (!entry.socket && Date.now() - entry.disconnectedAt >= this.graceMs) this.finish(entry, 'The reconnect window ended. Launch a new web terminal.')
      }
    }, 1000).unref()
  }
  exclusive<T>(owner: TerminalOwner, targetId: string, operation: () => Promise<T>) {
    const key = JSON.stringify([owner.userId, targetId])
    const work = (this.queues.get(key) ?? Promise.resolve()).then(operation)
    const done = work.then(() => {}, () => {})
    this.queues.set(key, done)
    void done.then(() => { if (this.queues.get(key) === done) this.queues.delete(key) })
    return work
  }
  private info(entry: HeldTerminal): WebTerminalInfo { return { id: entry.id, cols: entry.screen.cols, rows: entry.screen.rows, reconnectSeconds: this.graceMs / 1000 } }
  get(owner: TerminalOwner, id: string) {
    const entry = this.entries.get(id)
    if (!entry || !sameOwner(entry.owner, owner)) throw new AppError('Web terminal not found. Connect again from the session list.', 404)
    if (!this.validOwner(owner)) throw new AppError('Sign in to continue.', 401)
    return entry
  }
  async start(owner: TerminalOwner, target: SshTarget, sessionId: string, cols: number, rows: number, keySource: TerminalKeySource) {
    if (this.stopped) throw new AppError('Outpost is restarting. Try again shortly.', 409)
    if (!this.validOwner(owner)) throw new AppError('Sign in to continue.', 401)
    const identity = managedSshIdentity(target)
    if (keySource === 'account' && !identity) throw new AppError('Outpost account keys are only available in hosted mode.', 400)
    const existing = [...this.entries.values()].find(entry => sameOwner(entry.owner, owner) && entry.targetId === target.id && entry.sessionId === sessionId && entry.keySource === keySource)
    if (existing) return this.info(existing)
    this.checkLimit(owner)
    for (const [id, bucket] of this.starts) if (bucket.until <= Date.now()) this.starts.delete(id)
    const bucket = this.starts.get(owner.userId) ?? { count: 0, until: Date.now() + 60_000 }
    if (bucket.count >= 20 || this.starts.size >= 10000) throw new AppError('Too many terminal launches. Try again in a minute.', 429)
    bucket.count++; this.starts.set(owner.userId, bucket)
    const credential = keySource === 'uploaded' ? await this.keys.read(owner.userId, target.id) : null
    if (keySource === 'uploaded' && !credential) throw new AppError('Upload a private key for this target before launching a web terminal.', 409)
    const known = await this.keys.knownHostKeys(target)
    // The session lookup has already connected with OpenSSH and pinned the host.
    // Account keys reuse that trust record and never enter the upload vault.
    if (!credential && !known.length) throw new AppError('The target SSH host key has not been verified. Refresh the workspace before reconnecting.', 409)
    const privateKey = credential?.privateKey ?? await readFile(identity!.identityFile, 'utf8')
    // Recheck after I/O; different targets can launch concurrently.
    if (this.stopped) throw new AppError('Outpost is restarting. Try again shortly.', 409)
    this.checkLimit(owner)
    const trusted = credential?.hostKey ? [credential.hostKey] : known
    const hostAlgorithms: ServerHostKeyAlgorithm[] = trusted.flatMap(encoded => {
      const parsed = ssh2.utils.parseKey(Buffer.from(encoded, 'base64'))
      if (parsed instanceof Error) return []
      return parsed.type === 'ssh-rsa' ? ['rsa-sha2-512', 'rsa-sha2-256'] : [parsed.type as ServerHostKeyAlgorithm]
    })
    if (trusted.length && !hostAlgorithms.length) throw new AppError('The trusted SSH host key is invalid.', 409)
    const client = new ssh2.Client(), screen = new headless.Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true, logLevel: 'off' })
    const serializer = new serialize.SerializeAddon()
    screen.loadAddon(serializer as unknown as ITerminalAddon)
    const entry: HeldTerminal = { id: randomUUID(), owner, targetId: target.id, sessionId, keySource, client, channel: null, screen, serializer, socket: null, disconnectedAt: Date.now(), unacked: 0, pending: 0, replaying: false, alive: true, pong: true, blockedInput: false }
    screen.onData(data => { if (entry.alive && (!entry.socket || entry.replaying)) entry.channel?.write(data) })
    // Reserve the slot before connecting so simultaneous requests cannot bypass limits.
    this.entries.set(entry.id, entry)
    client.on('error', () => this.finish(entry, 'The SSH connection ended. Launch again to resume your coding session.'))
    client.on('close', () => this.finish(entry, 'The SSH connection ended. Launch again to resume your coding session.'))
    let hostError = ''
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const cleanup = () => { clearTimeout(deadline); client.off('error', fail); client.off('close', fail) }
        const fail = () => {
          if (settled) return
          settled = true; cleanup()
          reject(new AppError(hostError || `SSH connection failed. Check the target host and port, and authorize ${credential ? 'the uploaded key' : 'your Outpost account public key'} in root's authorized_keys.`, 409))
        }
        const deadline = setTimeout(fail, 20_000).unref()
        const ready = () => {
          const shell = target.environment?.shell ?? '/bin/bash'
          client.exec(`${quote(shell)} -lic ${quote(sessionAttachOperation(target, sessionId))}`, { pty: { term: 'xterm-256color', cols, rows, width: 0, height: 0 } }, (error, channel) => {
            if (error || !entry.alive || settled) { channel?.close(); return fail() }
            entry.channel = channel
            channel.on('drain', () => { entry.blockedInput = false })
            channel.on('data', (data: Buffer) => this.output(entry, data))
            channel.stderr.on('data', (data: Buffer) => this.output(entry, data))
            channel.on('error', () => this.finish(entry, 'The SSH terminal disconnected. Launch again to resume your coding session.'))
            channel.on('close', () => this.finish(entry, 'Terminal detached. Your coding session remains on the target.'))
            settled = true; cleanup(); resolve()
          })
        }
        client.once('ready', ready)
        client.once('error', fail)
        client.once('close', fail)
        client.connect({ host: target.host, port: target.port ?? 22, username: 'root', privateKey,
          readyTimeout: 15_000, keepaliveInterval: 15_000, keepaliveCountMax: 3,
          ...(hostAlgorithms.length ? { algorithms: { serverHostKey: hostAlgorithms } } : {}),
          hostVerifier: (key: Buffer, callback: (valid: boolean) => void) => {
            const verification = credential ? this.keys.verifyHost(owner.userId, target.id, credential, key, known) : Promise.resolve(known.includes(key.toString('base64')))
            void verification.then(valid => {
              if (!valid) hostError = 'SSH host key changed or differs from the trusted management key. Verify the server before reconnecting.'
              callback(valid && entry.alive)
            }, () => { hostError = 'Could not securely save the SSH host key.'; callback(false) })
          },
        })
      })
      if (!entry.alive || !this.validOwner(owner)) throw new AppError('Sign-in ended or terminal closed.', 401)
      return this.info(entry)
    } catch (error) { this.finish(entry, 'SSH connection failed.'); throw error }
  }
  private checkLimit(owner: TerminalOwner) {
    if ([...this.entries.values()].filter(entry => entry.owner.userId === owner.userId).length >= 4 || this.entries.size >= 128)
      throw new AppError('The web terminal limit has been reached. Disconnect another web terminal first.', 429)
  }
  private flow(entry: HeldTerminal) {
    const channel = entry.channel
    if (!entry.alive || !channel) return
    if (entry.replaying || entry.pending >= HIGH_WATER || entry.unacked >= HIGH_WATER || (entry.socket?.bufferedAmount ?? 0) >= HIGH_WATER) {
      channel.pause(); channel.stderr.pause()
    } else { channel.resume(); channel.stderr.resume() }
  }
  private output(entry: HeldTerminal, data: Buffer) {
    if (!entry.alive) return
    entry.pending += data.length
    entry.screen.write(data, () => { entry.pending -= data.length; this.flow(entry) })
    const socket = entry.socket
    if (socket?.readyState === WebSocket.OPEN && !entry.replaying) {
      entry.unacked += data.length
      socket.send(data, error => { if (error) socket.terminate(); this.flow(entry) })
    }
    this.flow(entry)
  }
  attach(owner: TerminalOwner, id: string, socket: WebSocket) {
    const entry = this.get(owner, id)
    if (entry.socket) entry.socket.close(4001, 'Opened in another tab')
    entry.socket = socket; entry.replaying = true; entry.unacked = 0; entry.pong = true
    // Keep new bytes in the SSH channel until the queued screen snapshot has
    // been sent; otherwise bytes after that snapshot's barrier would be lost.
    this.flow(entry)
    socket.on('error', () => socket.terminate())
    socket.on('pong', () => { if (entry.socket === socket) entry.pong = true })
    let inputBytes = 0, messages = 0, inputWindow = Date.now()
    // Handlers are registered synchronously before waiting for the screen snapshot.
    socket.on('message', (data, binary) => {
      if (entry.socket !== socket || !entry.alive) return
      if (!this.validOwner(owner)) return this.finish(entry, 'Sign-in ended. Sign in again to reconnect.')
      if (Date.now() - inputWindow > 1000) { inputWindow = Date.now(); inputBytes = 0; messages = 0 }
      if (++messages > 300) return socket.close(1008, 'Message rate exceeded')
      try {
        if (binary) throw new Error('binary input')
        const message = JSON.parse(data.toString())
        if (message.type === 'ack' && Number.isSafeInteger(message.bytes) && message.bytes >= 0 && message.bytes <= entry.unacked) {
          entry.unacked -= message.bytes; this.flow(entry)
        } else if (message.type === 'input' && typeof message.data === 'string' && Buffer.byteLength(message.data) <= 16 * 1024 && !entry.replaying) {
          inputBytes += Buffer.byteLength(message.data)
          if (inputBytes > 128 * 1024 || entry.blockedInput) return socket.close(1008, 'Input rate exceeded')
          entry.blockedInput = !(entry.channel?.write(message.data) ?? true)
        } else if (message.type === 'resize' && Number.isInteger(message.cols) && message.cols >= 20 && message.cols <= 300 && Number.isInteger(message.rows) && message.rows >= 5 && message.rows <= 120 && !entry.replaying) {
          if (entry.screen.cols !== message.cols || entry.screen.rows !== message.rows) {
            entry.screen.resize(message.cols, message.rows); entry.channel?.setWindow(message.rows, message.cols, 0, 0)
          }
        } else throw new Error('invalid message')
      } catch { socket.close(1008, 'Invalid terminal message') }
    })
    const heartbeat = setInterval(() => {
      if (entry.socket !== socket) return
      if (!entry.pong) return socket.terminate()
      entry.pong = false; socket.ping()
    }, 30_000).unref()
    socket.once('close', () => {
      clearInterval(heartbeat)
      if (entry.socket !== socket) return
      entry.socket = null; entry.unacked = 0; entry.disconnectedAt = Date.now(); this.flow(entry)
    })
    entry.screen.write('', () => {
      if (entry.socket !== socket || !entry.alive || socket.readyState !== WebSocket.OPEN) return
      const data = entry.serializer.serialize({ scrollback: 1000 })
      entry.unacked += Buffer.byteLength(data)
      socket.send(JSON.stringify({ type: 'snapshot', data, cols: entry.screen.cols, rows: entry.screen.rows }))
      entry.replaying = false; this.flow(entry)
    })
  }
  private finish(entry: HeldTerminal, message: string) {
    if (!entry.alive) return
    entry.alive = false; this.entries.delete(entry.id)
    if (entry.socket?.readyState === WebSocket.OPEN) { entry.socket.send(JSON.stringify({ type: 'closed', message })); entry.socket.close(1000, 'Terminal closed') }
    entry.channel?.close(); entry.client.destroy(); entry.screen.dispose()
  }
  disconnect(owner: TerminalOwner, id: string) { this.finish(this.get(owner, id), 'Terminal disconnected. Your coding session remains on the target.') }
  closeTarget(owner: TerminalOwner, targetId: string, filter: { sessionId?: string; keySource?: TerminalKeySource } = {}) {
    for (const entry of this.entries.values()) if (entry.owner.userId === owner.userId && entry.targetId === targetId && (!filter.sessionId || entry.sessionId === filter.sessionId) && (!filter.keySource || entry.keySource === filter.keySource)) this.finish(entry, 'Terminal access removed. Your coding session remains on the target.')
  }
  close() { this.stopped = true; clearInterval(this.cleanup); for (const entry of this.entries.values()) this.finish(entry, 'Outpost is restarting. Launch again to resume your coding session.') }
}
