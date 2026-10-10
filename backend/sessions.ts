import type { CodingSessionSearchInput, CodingSessionSearchResults, DirectorySuggestions, Target, Session, SessionImage, SessionImageInput, SessionInput, SessionList, SessionLaunchOptions } from '../shared/session-manager'
import { maxImageBytes } from '../shared/session-manager'
import { AppError } from './errors'
import { pythonCommand } from './runtime'
import { supportingPath } from './shell'
import { runProtocol } from './process'
import { transportFor } from './transport'
import { terminalScript } from './terminal'
import type { SignalEnvironment } from '../shared/signals'
import type { SignalChannels } from './signal-channels'

type SessionRequest = { action: 'list' }
  | ({ action: 'coding-search' } & CodingSessionSearchInput)
  | { action: 'directories'; path: string }
  | ({ action: 'create' } & SessionInput)
  | { action: 'get' | 'terminate' | 'delete'; id: string }
  | { action: 'acknowledge'; id: string; completionId: string }
  | { action: 'paste-image'; id: string; extension: string }

const imageExtensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

export function sessionLaunchOptions(input: SessionInput): SessionLaunchOptions {
  const options = { env: input.env ?? {}, args: input.args ?? '' }
  if (Buffer.byteLength(JSON.stringify(options)) > 16 * 1024) throw new AppError('Environment variables and arguments must fit within 16 KiB.', 400)
  return options
}

export const supportedShells = (target: Target) => transportFor(target).shells
export function sessionAttachOperation(target: Target, id: string, signals?: Pick<SignalEnvironment, 'OUTPOST_SIGNAL_ENV'>) {
  return `${supportingPath}; exec ${pythonCommand({ action: 'attach', id, context: transportFor(target).context, signals: signals?.OUTPOST_SIGNAL_ENV })}`
}
export function connectScript(target: Target, id: string, shell: 'bash' | 'powershell', signals?: SignalEnvironment) {
  const transport = transportFor(target)
  if (!transport.shells.includes(shell)) throw new AppError('This terminal shell is not supported for this local target', 400)
  const operation = sessionAttachOperation(target, id, signals)
  return terminalScript(transport.attach(operation), shell)
}

export interface SessionService {
  prepareSignals?(target: Target, id: string, setup: { scope: string; token: string }): Promise<SignalEnvironment | undefined>
  list(target: Target, signal?: AbortSignal): Promise<SessionList>
  search(target: Target, input: CodingSessionSearchInput, signal?: AbortSignal): Promise<CodingSessionSearchResults>
  directories(target: Target, path: string, signal?: AbortSignal): Promise<DirectorySuggestions>
  create(target: Target, input: SessionInput): Promise<Session>
  get(target: Target, id: string, signal?: AbortSignal): Promise<Session>
  acknowledge(target: Target, id: string, completionId: string): Promise<Session>
  terminate(target: Target, id: string): Promise<Session>
  remove(target: Target, id: string): Promise<void>
  pasteImage(target: Target, id: string, image: SessionImageInput, signal?: AbortSignal): Promise<SessionImage>
}

export class SessionClient implements SessionService {
  constructor(private env = process.env, private requireAccountIdentity = false, private signals?: SignalChannels) {}
  async prepareSignals(target: Target, id: string, setup: { scope: string; token: string }) { return this.signals?.prepare(target, id, setup) }
  private async run<T>(target: Target, request: SessionRequest, signal?: AbortSignal) {
    const transport = transportFor(target, this.requireAccountIdentity)
    const operation = `${supportingPath}; exec ${pythonCommand({ ...request, context: transport.context })}`
    const script = `set -eu\n${operation}\n`
    return runProtocol<T>(transport.script(), script, { signal, env: this.env })
  }
  async list(target: Target, signal?: AbortSignal) { return this.run<SessionList>(target, { action: 'list' }, signal) }
  async search(target: Target, input: CodingSessionSearchInput, signal?: AbortSignal) {
    return this.run<CodingSessionSearchResults>(target, { action: 'coding-search', ...input }, signal)
  }
  async directories(target: Target, path: string, signal?: AbortSignal) {
    return this.run<DirectorySuggestions>(target, { action: 'directories', path }, signal)
  }
  async create(target: Target, input: SessionInput) { return this.run<Session>(target, { action: 'create', ...input, ...sessionLaunchOptions(input) }) }
  async get(target: Target, id: string, signal?: AbortSignal) { return this.run<Session>(target, { action: 'get', id }, signal) }
  async acknowledge(target: Target, id: string, completionId: string) { return this.run<Session>(target, { action: 'acknowledge', id, completionId }) }
  async terminate(target: Target, id: string) { return this.run<Session>(target, { action: 'terminate', id }) }
  async remove(target: Target, id: string) { await this.run(target, { action: 'delete', id }) }
  async pasteImage(target: Target, id: string, image: SessionImageInput, signal?: AbortSignal) {
    const extension = imageExtensions[image.mediaType]
    if (!extension) throw new AppError('Unsupported image type. Use a PNG, JPEG, GIF, or WebP image.', 400)
    const data = image.data
    if (data.length > Math.ceil(maxImageBytes / 3) * 4) throw new AppError('Images are limited to 16 MB.', 413)
    if (data.length < 8 || data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new AppError('Invalid image data', 400)
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length > maxImageBytes) throw new AppError('Images are limited to 16 MB.', 413)
    if (bytes.toString('base64') !== data) throw new AppError('Invalid image data', 400)
    const transport = transportFor(target, this.requireAccountIdentity)
    const operation = `${supportingPath}; exec ${pythonCommand({ action: 'paste-image', id, extension, context: transport.context })}`
    // The image rides the script's stdin as a heredoc: the request payload
    // passed as an argument is limited to a fraction of ARG_MAX.
    const script = `set -eu
${operation} <<'OUTPOST_IMAGE'
${data}
OUTPOST_IMAGE
`
    return runProtocol<SessionImage>(transport.script(), script, { env: this.env, signal })
  }
}
