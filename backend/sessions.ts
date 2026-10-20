import type {
  ConversationResults,
  ConversationSearch,
  DirectorySuggestions,
  Session,
  SessionForkInput,
  SessionInput,
  SessionList,
  SessionLaunchOptions,
  Target,
} from '../shared/model'
import { imageExtensions, imageProblem, type ImageMediaType, type UploadedImage } from '../shared/images'
import type { Owner } from './deployment'
import { AppError } from './errors'
import { runProtocol, type Command } from './process'
import { runtimeOperation } from './runtime'
import type { Transport } from './transport'
import type { Workspace } from './workspace'

/** A target resolved for one owner: its settings and how to reach it. */
export interface TargetContext {
  owner: Owner
  target: Target
  transport: Transport
  workspace: Workspace
}

type Request =
  | { action: 'attach'; id: string; cols: number; rows: number; start: boolean }
  | { action: 'list' }
  | ({ action: 'coding-search' } & ConversationSearch)
  | { action: 'directories'; path: string }
  | ({ action: 'create'; creationKey?: string } & SessionInput & SessionLaunchOptions)
  | ({ action: 'fork'; id: string } & SessionForkInput)
  | { action: 'get' | 'terminate' | 'delete'; id: string }
  | { action: 'acknowledge'; id: string; completionId: string }
  | { action: 'upload-image'; id: string; extension: string; size: number }

export function launchOptions(input: SessionInput): SessionLaunchOptions {
  const options = { env: input.env ?? {}, args: input.args ?? '' }
  if (Buffer.byteLength(JSON.stringify(options)) > 16 * 1024)
    throw new AppError('Environment variables and arguments must fit within 16 KiB.', 400)
  return options
}

export interface SessionService {
  list(context: TargetContext, signal?: AbortSignal): Promise<SessionList>
  get(context: TargetContext, id: string, signal?: AbortSignal): Promise<Session>
  create(context: TargetContext, input: SessionInput, creationKey?: string): Promise<Session>
  fork(context: TargetContext, id: string, input: SessionForkInput): Promise<Session>
  acknowledge(context: TargetContext, id: string, completionId: string): Promise<Session>
  terminate(context: TargetContext, id: string): Promise<Session>
  remove(context: TargetContext, id: string): Promise<void>
  uploadImage(
    context: TargetContext,
    id: string,
    data: Buffer,
    mediaType: ImageMediaType,
    signal: AbortSignal,
  ): Promise<UploadedImage>
  directories(context: TargetContext, path: string, signal?: AbortSignal): Promise<DirectorySuggestions>
  search(context: TargetContext, input: ConversationSearch, signal?: AbortSignal): Promise<ConversationResults>
  /** The relay command for one terminal connection; see TerminalBroker. */
  attach(context: TargetContext, id: string, cols: number, rows: number, start: boolean): Command
}

export class SessionClient implements SessionService {
  constructor(private env: NodeJS.ProcessEnv = process.env) {}
  private command({ transport }: TargetContext, request: Request): Command {
    const operation = runtimeOperation(request)
    return { ...transport.runtime(operation.script), input: operation.input }
  }
  private run<T>(context: TargetContext, request: Request, signal?: AbortSignal, stdin: string | Uint8Array = '') {
    return runProtocol<T>(this.command(context, request), stdin, {
      signal,
      env: this.env,
      // Explicit allowlist: new operations and all mutations stay non-retryable.
      readOnly: ['list', 'get', 'directories', 'coding-search'].includes(request.action),
      timeoutMs: ['fork', 'upload-image'].includes(request.action) ? 120_000 : undefined,
    })
  }
  list(context: TargetContext, signal?: AbortSignal) {
    return this.run<SessionList>(context, { action: 'list' }, signal)
  }
  get(context: TargetContext, id: string, signal?: AbortSignal) {
    return this.run<Session>(context, { action: 'get', id }, signal)
  }
  create(context: TargetContext, input: SessionInput, creationKey?: string) {
    return this.run<Session>(context, { action: 'create', ...input, ...launchOptions(input), creationKey })
  }
  fork(context: TargetContext, id: string, input: SessionForkInput) {
    return this.run<Session>(context, { action: 'fork', id, ...input })
  }
  acknowledge(context: TargetContext, id: string, completionId: string) {
    return this.run<Session>(context, { action: 'acknowledge', id, completionId })
  }
  terminate(context: TargetContext, id: string) {
    return this.run<Session>(context, { action: 'terminate', id })
  }
  async remove(context: TargetContext, id: string) {
    await this.run(context, { action: 'delete', id })
  }
  directories(context: TargetContext, path: string, signal?: AbortSignal) {
    return this.run<DirectorySuggestions>(context, { action: 'directories', path }, signal)
  }
  search(context: TargetContext, input: ConversationSearch, signal?: AbortSignal) {
    return this.run<ConversationResults>(context, { action: 'coding-search', ...input }, signal)
  }
  uploadImage(context: TargetContext, id: string, data: Buffer, mediaType: ImageMediaType, signal: AbortSignal) {
    const problem = imageProblem({ type: mediaType, size: data.length })
    if (problem) throw new AppError(problem, 400)
    return this.run<UploadedImage>(
      context,
      {
        action: 'upload-image',
        id,
        extension: imageExtensions[mediaType],
        size: data.length,
      },
      signal,
      data,
    )
  }
  attach(context: TargetContext, id: string, cols: number, rows: number, start: boolean) {
    return this.command(context, { action: 'attach', id, cols, rows, start })
  }
}
