import type { ConversationResults, ConversationSearch, DirectorySuggestions, Session, SessionImage, SessionImageInput, SessionInput, SessionList, SessionLaunchOptions, Target } from '../shared/model'
import { imageExtensions, maxImageBytes } from '../shared/model'
import type { Owner } from './deployment'
import { AppError } from './errors'
import { runProtocol, type Command } from './process'
import { runtimeOperation } from './runtime'
import type { Transport } from './transport'
import type { Workspace } from './workspace'

/** A target resolved for one owner: its settings and how to reach it. */
export interface TargetContext { owner: Owner; target: Target; transport: Transport; workspace: Workspace }

type Request = { action: 'list' }
  | ({ action: 'coding-search' } & ConversationSearch)
  | { action: 'directories'; path: string }
  | ({ action: 'create' } & SessionInput & SessionLaunchOptions)
  | { action: 'get' | 'terminate' | 'delete'; id: string }
  | { action: 'acknowledge'; id: string; completionId: string }
  | { action: 'paste-image'; id: string; extension: string }

export function launchOptions(input: SessionInput): SessionLaunchOptions {
  const options = { env: input.env ?? {}, args: input.args ?? '' }
  if (Buffer.byteLength(JSON.stringify(options)) > 16 * 1024) throw new AppError('Environment variables and arguments must fit within 16 KiB.', 400)
  return options
}

export function imageData(image: SessionImageInput) {
  const extension = imageExtensions[image.mediaType]
  if (!extension) throw new AppError('Unsupported image type. Use a PNG, JPEG, GIF, or WebP image.', 400)
  const data = image.data
  if (data.length > Math.ceil(maxImageBytes / 3) * 4) throw new AppError('Images are limited to 16 MB.', 413)
  if (data.length < 8 || data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new AppError('Invalid image data', 400)
  return { extension, data }
}

export interface SessionService {
  list(context: TargetContext, signal?: AbortSignal): Promise<SessionList>
  get(context: TargetContext, id: string, signal?: AbortSignal): Promise<Session>
  create(context: TargetContext, input: SessionInput): Promise<Session>
  acknowledge(context: TargetContext, id: string, completionId: string): Promise<Session>
  terminate(context: TargetContext, id: string): Promise<Session>
  remove(context: TargetContext, id: string): Promise<void>
  pasteImage(context: TargetContext, id: string, image: SessionImageInput): Promise<SessionImage>
  directories(context: TargetContext, path: string, signal?: AbortSignal): Promise<DirectorySuggestions>
  search(context: TargetContext, input: ConversationSearch, signal?: AbortSignal): Promise<ConversationResults>
  /** The relay command for one terminal connection; see TerminalBroker. */
  attach(context: TargetContext, id: string, cols: number, rows: number): Command
}

export class SessionClient implements SessionService {
  constructor(private env: NodeJS.ProcessEnv = process.env) {}
  private run<T>({ transport }: TargetContext, request: Request, signal?: AbortSignal, stdin = '') {
    const operation = runtimeOperation({ ...request, context: transport.context })
    return runProtocol<T>(transport.management(), `set -eu\n${operation}${stdin}\n`, { signal, env: this.env })
  }
  list(context: TargetContext, signal?: AbortSignal) { return this.run<SessionList>(context, { action: 'list' }, signal) }
  get(context: TargetContext, id: string, signal?: AbortSignal) { return this.run<Session>(context, { action: 'get', id }, signal) }
  create(context: TargetContext, input: SessionInput) { return this.run<Session>(context, { action: 'create', ...input, ...launchOptions(input) }) }
  acknowledge(context: TargetContext, id: string, completionId: string) { return this.run<Session>(context, { action: 'acknowledge', id, completionId }) }
  terminate(context: TargetContext, id: string) { return this.run<Session>(context, { action: 'terminate', id }) }
  async remove(context: TargetContext, id: string) { await this.run(context, { action: 'delete', id }) }
  directories(context: TargetContext, path: string, signal?: AbortSignal) { return this.run<DirectorySuggestions>(context, { action: 'directories', path }, signal) }
  search(context: TargetContext, input: ConversationSearch, signal?: AbortSignal) { return this.run<ConversationResults>(context, { action: 'coding-search', ...input }, signal) }
  pasteImage(context: TargetContext, id: string, image: SessionImageInput) {
    const { extension, data } = imageData(image)
    // The image rides the script's stdin as a heredoc; arguments are limited to a fraction of ARG_MAX.
    return this.run<SessionImage>(context, { action: 'paste-image', id, extension }, undefined, ` <<'OUTPOST_IMAGE'\n${data}\nOUTPOST_IMAGE`)
  }
  attach({ transport }: TargetContext, id: string, cols: number, rows: number) {
    return transport.attach(runtimeOperation({ action: 'attach', id, cols, rows, context: transport.context }))
  }
}
