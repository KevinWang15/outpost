import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SshTarget } from '../shared/session-manager'
import type { TerminalKeyInfo, TerminalKeyStatus } from '../shared/web-terminal'
import { AppError } from './errors'
import { managedSshIdentity } from './account-ssh'
import { runCommand } from './process'
import { parseTerminalKey } from './terminal-key-parser'

export interface TerminalCredential {
  privateKey: string; passphrase: string; fingerprint: string; type: string; uploadedAt: string
  hostKey: string | null
}
const fingerprint = (key: Buffer) => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
const metadata = (key: TerminalCredential): TerminalKeyInfo => ({ fingerprint: key.fingerprint, type: key.type, uploadedAt: key.uploadedAt, hostFingerprint: key.hostKey ? fingerprint(Buffer.from(key.hostKey, 'base64')) : null })

// One vault per manager. Secrets are authenticated against both account and target.
export class TerminalKeys {
  private master: Promise<Buffer> | null = null
  private directory: string
  private parsing = 0
  private uploads = new Map<string, { count: number; until: number }>()
  constructor(directory: string, private configuredKey = process.env.OUTPOST_TERMINAL_ENCRYPTION_KEY) {
    this.directory = join(directory, 'terminal-keys')
  }
  get available() { return !this.configuredKey || /^[A-Za-z0-9+/]{43}=$/.test(this.configuredKey) }
  private masterKey() {
    if (!this.available) throw new AppError('OUTPOST_TERMINAL_ENCRYPTION_KEY must be 32 bytes encoded as base64.', 409)
    this.master ??= this.prepareMaster().catch(error => { this.master = null; throw error })
    return this.master
  }
  private async prepareMaster() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await chmod(this.directory, 0o700)
    if (this.configuredKey) return Buffer.from(this.configuredKey, 'base64')
    let path = join(this.directory, 'master-key')
    try { await stat(path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // Retain the key used by existing local/development installations.
      const legacy = join(this.directory, 'development-master-key')
      try { await stat(legacy); path = legacy }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    try { await writeFile(path, randomBytes(32), { mode: 0o600, flag: 'wx' }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    await chmod(path, 0o600)
    const key = await readFile(path)
    if (key.length !== 32) throw new AppError('The saved terminal encryption key is invalid. Restore it from a backup.', 409)
    return key
  }
  private scope(owner: string, targetId: string) { return JSON.stringify([owner, targetId]) }
  private path(owner: string, targetId: string) { return join(this.directory, `${createHash('sha256').update(this.scope(owner, targetId)).digest('hex')}.json`) }
  async status(owner: string, targetId: string): Promise<TerminalKeyStatus> {
    if (!this.available) return { encryptionAvailable: false, key: null }
    const key = await this.read(owner, targetId)
    return { encryptionAvailable: true, key: key ? metadata(key) : null }
  }
  async read(owner: string, targetId: string): Promise<TerminalCredential | null> {
    let encrypted: string
    try { encrypted = await readFile(this.path(owner, targetId), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    const master = await this.masterKey()
    try {
      const record = JSON.parse(encrypted)
      if (record.version !== 1) throw new Error('version')
      const decipher = createDecipheriv('aes-256-gcm', master, Buffer.from(record.iv, 'base64'))
      decipher.setAAD(Buffer.from(this.scope(owner, targetId)))
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'))
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]).toString('utf8'))
    } catch { throw new AppError('The saved terminal key cannot be decrypted. Restore the original encryption key or replace the uploaded key.', 409) }
  }
  private async write(owner: string, targetId: string, key: TerminalCredential) {
    const master = await this.masterKey(), iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', master, iv)
    cipher.setAAD(Buffer.from(this.scope(owner, targetId)))
    const data = Buffer.concat([cipher.update(JSON.stringify(key), 'utf8'), cipher.final()])
    const destination = this.path(owner, targetId), temporary = `${destination}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), { flag: 'wx', mode: 0o600 })
      await rename(temporary, destination)
    } finally { await rm(temporary, { force: true }) }
  }
  async upload(owner: string, targetId: string, privateKey: string, passphrase = '') {
    await this.masterKey()
    for (const [id, entry] of this.uploads) if (entry.until <= Date.now()) this.uploads.delete(id)
    const bucket = this.uploads.get(owner) ?? { count: 0, until: Date.now() + 15 * 60_000 }
    if (bucket.count >= 10 || this.uploads.size >= 10000 || this.parsing >= 4) throw new AppError('Too many key uploads. Please wait before trying again.', 429)
    bucket.count++; this.uploads.set(owner, bucket); this.parsing++
    let key: Awaited<ReturnType<typeof parseTerminalKey>>
    try { key = await parseTerminalKey(privateKey, passphrase) } finally { this.parsing-- }
    // Replacing a login key must not silently reset an already trusted host key.
    const previous = await this.read(owner, targetId).catch(error => { if (error instanceof AppError && error.statusCode === 409) return null; throw error })
    const credential: TerminalCredential = { privateKey: key.privateKey, passphrase: '', fingerprint: fingerprint(Buffer.from(key.publicKey, 'base64')), type: key.type, uploadedAt: new Date().toISOString(), hostKey: previous?.hostKey ?? null }
    await this.write(owner, targetId, credential)
    return metadata(credential)
  }
  remove(owner: string, targetId: string) { return rm(this.path(owner, targetId), { force: true }) }
  async knownHostKeys(target: SshTarget): Promise<string[]> {
    const identity = managedSshIdentity(target)
    if (!identity) return []
    try { await stat(identity.knownHostsFile) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const host = target.port && target.port !== 22 ? `[${target.host}]:${target.port}` : target.host
    const result = await runCommand({ executable: 'ssh-keygen', args: ['-F', host, '-f', identity.knownHostsFile], label: 'SSH host verification' }, '', { timeoutMs: 5000 })
    // A missing entry/file is normal on first use; command execution errors still fail closed.
    if (result.code !== 0 && result.code !== 1) throw new AppError('Could not verify the target SSH host key.', 409)
    const entries = result.stdout.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(line => line.split(/\s+/))
    if (entries.some(fields => fields[0] === '@revoked')) throw new AppError('This target has a revoked SSH host key. Verify the server before reconnecting.', 409)
    if (entries.some(fields => fields[0].startsWith('@'))) throw new AppError('Web terminals require a pinned SSH host key; known-host certificate authorities are not supported.', 409)
    return entries.map(fields => fields[2]).filter(Boolean)
  }
  async verifyHost(owner: string, targetId: string, credential: TerminalCredential, key: Buffer, known: string[]) {
    const encoded = key.toString('base64')
    if ((credential.hostKey && credential.hostKey !== encoded) || (known.length && !known.includes(encoded))) return false
    if (!credential.hostKey) { credential.hostKey = encoded; await this.write(owner, targetId, credential) }
    return true
  }
}
