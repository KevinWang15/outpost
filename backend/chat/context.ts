import { randomUUID } from 'node:crypto'
import {
  sessionKey,
  type ChannelMessage,
  type ChatServerMessage,
  type ChatSession,
  type ChatTarget,
  type Delivery,
  type SessionRef,
} from '../../shared/chatApi'
import type { Session } from '../../shared/model'
import type { Deployment, Owner } from '../deployment'
import type { LogInput } from '../logs/activity'
import type { SessionFileClient } from '../sessionFiles'
import type { SessionClient, TargetContext } from '../sessions'
import type { ChannelFiles } from './files'
import type { ChatConnector, ChatLink } from './links'
import type { ChatStore } from './store'

export interface ChatClient {
  owner: Owner
  send(message: ChatServerMessage): void
}

export interface Account {
  userId: string
  /** Any current login of the account; background work resolves targets with it. */
  owner: Owner
  store: ChatStore
  /** Files attached to the user's channel posts. */
  files: ChannelFiles
  clients: Set<ChatClient>
  sessions: Map<string, Session[]>
  errors: Map<string, string>
  machines: Map<string, { name: string }>
  view: ChatSession[]
  targets: ChatTarget[]
  refreshedAt: number
  deletedDuringRefresh: Set<string>
  refreshing: Promise<void> | null
  viewKey: string
  poller: NodeJS.Timeout | null
}

export interface ChatHubDependencies {
  deployment: Deployment
  resolve(owner: Owner, targetId: string): Promise<TargetContext>
  list(context: TargetContext, signal?: AbortSignal): Promise<Session[]>
  /** Session files on targets, to give channel members the files a delivery carries. */
  files: Pick<SessionFileClient, 'list' | 'read' | 'receive'>
  /** Sessions running in a terminal take messages through their terminal service. */
  terminals: Pick<SessionClient, 'deliver' | 'deliveries'>
  connect: ChatConnector
  /** How long a target may take to accept a composed prompt. */
  promptMs?: number
  /** How long a connected chat may stay silent (tests). */
  probeMs?: number
  /** How often messages typed into terminals are checked on (tests). */
  terminalPollMs?: number
  /** Records what the hub did in the account's activity log. */
  log?(owner: Owner, input: LogInput): void
}

export const notStopped = (delivery: Delivery) => delivery.state !== 'done' && delivery.state !== 'failed'
export const now = () => new Date().toISOString()
/** The key a delivery's prompt carries; the chat host dedupes by it. */
export const promptKey = (delivery: Delivery) => delivery.id.replace(/-/g, '')
export const linkKey = (userId: string, ref: SessionRef) => `${userId}/${sessionKey(ref)}`

export function findSession(account: Account, ref: SessionRef) {
  return account.view.find(item => item.targetId === ref.targetId && item.id === ref.sessionId) ?? null
}

/** The session and machine a schedule or delivery is for, as the log names them. */
export function sessionOf(account: Account, ref: SessionRef) {
  const session = findSession(account, ref)
  return {
    machine: { id: ref.targetId, name: account.machines.get(ref.targetId)?.name ?? ref.targetId },
    session: { id: ref.sessionId, name: session?.name ?? ref.sessionId.slice(0, 8) },
  }
}

export function broadcast(account: Account, message: ChatServerMessage) {
  for (const client of account.clients) client.send(message)
}

export function noticeMessage(
  channelId: string,
  level: 'info' | 'warning' | 'error',
  text: string,
  root: string = randomUUID(),
): ChannelMessage {
  return {
    id: randomUUID(),
    channelId,
    at: now(),
    author: { kind: 'outpost', level },
    text,
    mentions: [],
    root,
    hop: 0,
    turn: null,
    key: null,
    files: [],
  }
}

/** Shared hub primitives exposed to the delivery, channel, schedule, and tool managers. */
export interface HubRuntime {
  readonly dependencies: ChatHubDependencies
  readonly accounts: Map<string, Promise<Account>>
  readonly links: Map<string, ChatLink>
  readonly stopped: boolean
  account(owner: Owner): Promise<Account>
  evictAccount(userId: string): void
  fresh(account: Account): Promise<void>
  link(owner: Owner, ref: SessionRef): Promise<ChatLink>
  log(account: Account, input: LogInput): void
}
