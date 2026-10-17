import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { TargetInput } from '../shared/model'
import type { DesktopAccount } from '../shared/desktopAuth'
import { isLoopbackAddress } from '../shared/loopback'
import { AppError } from './errors'
import type { SshIdentity } from './transport'
import { Workspace } from './workspace'

/** Who a request or terminal connection belongs to. `loginId` ties hosted
 * grants to one login so signing out revokes them. */
export interface Owner {
  userId: string
  loginId: string
}
export interface AccountIdentity {
  account: DesktopAccount
  /** Changes when credentials are replaced; never sent to a client. */
  revision: string
}

/** The only place where local and hosted installations differ (principle 3). */
export interface Deployment {
  readonly mode: 'local' | 'hosted'
  readonly directory: string
  readonly secret: string
  readonly localTargets: boolean
  /** Returns a rejection message for requests outside this deployment's network policy. */
  admits(request: FastifyRequest): string | null
  owner(request: FastifyRequest): Owner
  active(owner: Owner): boolean
  account(userId: string): AccountIdentity | null
  workspace(owner: Owner): Workspace
  identity(owner: Owner): Promise<SshIdentity | null>
  /** Public origin used in links that leave the browser, e.g. outpost:// URLs. */
  origin(request: FastifyRequest): string
  validateTarget(input: TargetInput): void
  register(app: FastifyInstance): void
  close(): void
}

const loopbackHost = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host)
function hostname(value: string | undefined) {
  try {
    return new URL(`http://${value}`).hostname
  } catch {
    return ''
  }
}

export async function serverSecret(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const path = join(directory, 'secret')
  try {
    await writeFile(path, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const secret = (await readFile(path, 'utf8')).trim()
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error(`${path} is invalid. Remove it to generate a new secret.`)
  return secret
}

/** Local tool: one user, loopback only, the user's own OpenSSH configuration. */
export class LocalDeployment implements Deployment {
  readonly mode = 'local'
  readonly localTargets = process.platform === 'linux'
  private store: Workspace
  private static readonly owner: Owner = { userId: 'local', loginId: 'local' }
  private constructor(
    readonly directory: string,
    readonly secret: string,
  ) {
    this.store = new Workspace(directory)
  }
  static async open(directory: string) {
    return new LocalDeployment(directory, await serverSecret(directory))
  }
  admits(request: FastifyRequest) {
    if (!isLoopbackAddress(request.ip))
      return 'Outpost only accepts connections from this computer. Use an SSH tunnel for remote access.'
    if (!loopbackHost(hostname(request.headers.host))) return 'Use the configured Outpost address.'
    if (request.headers.origin) {
      let origin = ''
      try {
        origin = new URL(request.headers.origin).hostname
      } catch {
        /* rejected below */
      }
      if (!loopbackHost(origin)) return 'Cross-origin requests are not allowed'
    }
    return null
  }
  owner() {
    return LocalDeployment.owner
  }
  active() {
    return true
  }
  account(userId: string): AccountIdentity | null {
    return userId === 'local'
      ? { account: { id: 'local', name: 'Local workspace', email: null }, revision: 'local' }
      : null
  }
  workspace() {
    return this.store
  }
  async identity() {
    return null
  }
  origin(request: FastifyRequest) {
    return `http://${request.headers.host}`
  }
  validateTarget(input: TargetInput) {
    if (input.kind === 'local' && !this.localTargets)
      throw new AppError('This computer can be a target when the Outpost server runs on Linux, including WSL.', 400)
  }
  register(app: FastifyInstance) {
    app.get('/api/auth/session', async () => ({ mode: 'local', user: null }))
  }
  close() {}
}
