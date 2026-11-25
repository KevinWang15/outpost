import type { Scrollback } from '../shared/terminalService'
import type {
  ConversationResults,
  ConversationSearch,
  DirectorySuggestions,
  Session,
  SessionForkInput,
  SessionInput,
  SessionUpdate,
  Target,
} from '../shared/model'
import type { TerminalDelivery } from '../shared/machine'
import type { Owner } from './deployment'
import { AppError } from './errors'
import type { MachineConnection, Stream } from './machines'
import type { Transport } from './transport'
import type { Workspace } from './workspace'

/** A target resolved for one owner: its settings and its machine connection. */
export interface TargetContext {
  owner: Owner
  target: Target
  transport: Transport | null
  machine: MachineConnection
  workspace: Workspace
}

export function launchSize(input: { env?: Record<string, string>; args?: string }) {
  if (Buffer.byteLength(JSON.stringify({ env: input.env ?? {}, args: input.args ?? '' })) > 16 * 1024)
    throw new AppError('Environment variables and arguments must fit within 16 KiB.', 400)
}

/** Send a whole buffer on a stream and wait for the node's answer. */
export function upload(stream: Stream, data: Buffer, signal?: AbortSignal) {
  return new Promise<unknown>((resolve, reject) => {
    stream.onClose((error, result) => (error ? reject(error) : resolve(result)))
    signal?.addEventListener('abort', () => reject(new AppError('The upload was cancelled.', 499)), { once: true })
    stream.write(data)
    stream.end()
  })
}

/** Sessions live on their machine; every operation asks its node. */
export class SessionClient {
  list({ machine }: TargetContext, signal?: AbortSignal) {
    return machine.call<{ sessions: Session[] }>('sessions.list', {}, { signal })
  }
  get({ machine }: TargetContext, id: string, signal?: AbortSignal) {
    return machine.call<Session>('sessions.get', { id }, { signal })
  }
  create({ machine }: TargetContext, input: SessionInput, creationKey?: string) {
    launchSize(input)
    return machine.call<Session>('sessions.create', { input, creationKey }, { timeoutMs: 120_000 })
  }
  fork({ machine }: TargetContext, id: string, input: SessionForkInput) {
    return machine.call<Session>('sessions.fork', { id, ...input }, { timeoutMs: 120_000 })
  }
  update({ machine }: TargetContext, id: string, update: SessionUpdate) {
    launchSize(update)
    return machine.call<Session>('sessions.update', { id, update })
  }
  switch({ machine }: TargetContext, id: string, conversation: string, reclaim = false) {
    return machine.call<Session>('sessions.switch', { id, conversation, ...(reclaim ? { reclaim: true } : {}) })
  }
  newConversation({ machine }: TargetContext, id: string) {
    return machine.call<Session>('sessions.newConversation', { id }, { timeoutMs: 120_000 })
  }
  acknowledge({ machine }: TargetContext, id: string, completionId: string) {
    return machine.call<Session>('sessions.acknowledge', { id, completionId })
  }
  /** A message for a session running in a terminal; the key makes a resend harmless. */
  deliver({ machine }: TargetContext, id: string, key: string, text: string, files: string[] = []) {
    return machine.call<TerminalDelivery>('sessions.deliver', { id, key, text, files })
  }
  deliveries({ machine }: TargetContext, id: string, keys: string[]) {
    return machine.call<TerminalDelivery[]>('sessions.deliveries', { id, keys })
  }
  terminate({ machine }: TargetContext, id: string) {
    return machine.call<Session>('sessions.terminate', { id }, { timeoutMs: 60_000 })
  }
  async remove({ machine }: TargetContext, id: string) {
    await machine.call('sessions.delete', { id })
  }
  directories({ machine }: TargetContext, path: string, signal?: AbortSignal) {
    return machine.call<DirectorySuggestions>('directories', { path }, { signal })
  }
  search({ machine }: TargetContext, input: ConversationSearch, signal?: AbortSignal) {
    return machine.call<ConversationResults>('conversations.search', input, { signal, timeoutMs: 60_000 })
  }
  /** A terminal attachment: the terminal service's own protocol, carried as a stream. */
  attach(
    { machine }: TargetContext,
    id: string,
    cols: number,
    rows: number,
    start: boolean,
    signal?: AbortSignal,
    scrollback?: Scrollback,
  ): Promise<Stream> {
    return machine.open('terminal', { session: id, cols, rows, start, scrollback }, signal)
  }
  /** The server's link to a session's chat host, carried as a stream. */
  chatAttach({ machine }: TargetContext, id: string, start: boolean): Promise<Stream> {
    return machine.open('chat', { session: id, start })
  }
}
export type SessionService = SessionClient
