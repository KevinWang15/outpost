import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AccountSshKey } from '../shared/auth'
import type { SshTarget, Target } from '../shared/session-manager'
import { AppError } from './errors'
import { runCommand } from './process'
import { TargetStore } from './store'

interface ManagedSshIdentity { identityFile: string; knownHostsFile: string }
const identities = new WeakMap<SshTarget, ManagedSshIdentity>()
export function managedSshIdentity(target: SshTarget) { return identities.get(target) }

export class AccountSshKeys {
  private pending = new Map<string, Promise<AccountSshKey>>()
  constructor(private directory: string) {}
  paths(userId: string): ManagedSshIdentity {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(userId)) throw new AppError('Invalid account', 403)
    const directory = join(this.directory, 'users', userId)
    return { identityFile: join(directory, 'ssh-key'), knownHostsFile: join(directory, 'known_hosts') }
  }
  async publicKey(userId: string): Promise<AccountSshKey> {
    const active = this.pending.get(userId)
    if (active) return active
    const work = this.prepare(userId)
    this.pending.set(userId, work)
    try { return await work } finally { this.pending.delete(userId) }
  }
  private async prepare(userId: string): Promise<AccountSshKey> {
    const { identityFile } = this.paths(userId)
    const directory = join(this.directory, 'users', userId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    try { await stat(identityFile) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const temporary = join(directory, `ssh-key.${randomUUID()}.tmp`)
      try {
        const result = await runCommand({ executable: 'ssh-keygen', args: ['-q', '-t', 'ed25519', '-N', '', '-C', `outpost-${userId}`, '-f', temporary], label: 'SSH key generation' }, '', { timeoutMs: 10_000 })
        if (result.code !== 0) throw new AppError('Could not generate your SSH key. Ensure OpenSSH is installed on the Outpost server.', 503)
        await chmod(temporary, 0o600)
        // Publish the public key first; a crash can then safely retry generation.
        await rename(`${temporary}.pub`, `${identityFile}.pub`)
        await rename(temporary, identityFile)
      } finally {
        await rm(temporary, { force: true })
        await rm(`${temporary}.pub`, { force: true })
      }
    }
    await chmod(identityFile, 0o600)
    const publicKey = (await readFile(`${identityFile}.pub`, 'utf8')).trim()
    const fields = publicKey.split(/\s+/)
    if (fields[0] !== 'ssh-ed25519' || !fields[1]) throw new AppError('Your SSH key is invalid. Contact the Outpost administrator.', 503)
    return { publicKey, fingerprint: `SHA256:${createHash('sha256').update(Buffer.from(fields[1], 'base64')).digest('base64').replace(/=+$/, '')}` }
  }
}

export class AccountTargetStore extends TargetStore {
  constructor(directory: string, private userId: string, private keys: AccountSshKeys) { super(join(directory, 'users', userId)) }
  override add(target: Target) {
    if (target.kind !== 'ssh') throw new AppError('Hosted workspaces support SSH targets. Local targets are available in local mode.', 400)
    return super.add(target)
  }
  override async get(id: string) {
    const target = await super.get(id)
    if (target.kind !== 'ssh') throw new AppError('This target is unavailable in a hosted workspace.', 403)
    await this.keys.publicKey(this.userId)
    identities.set(target, this.keys.paths(this.userId))
    return target
  }
}
