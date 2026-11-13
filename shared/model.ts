import type { Static } from 'typebox'
import type { SessionActivity } from './activity'
import type { HarnessId } from './harnesses'
import type * as schemas from './schemas'

// Inputs and stored records are derived from their validation schemas.
export type ExecutionEnvironment = Static<typeof schemas.environment>
export type TargetInput = Static<typeof schemas.targetInput>
export type TargetUpdate = Static<typeof schemas.targetUpdate>
export type Target = Static<typeof schemas.targetRecord>
export type SshTarget = Extract<Target, { kind: 'ssh' }>
export type SessionInput = Static<typeof schemas.sessionInput>
export type SessionForkInput = Static<typeof schemas.sessionForkInput>
export type ConversationSearch = Static<typeof schemas.conversationSearch>
export type SoftwareId = (typeof schemas.softwareIds)[number]
export interface Environment {
  mode: 'local' | 'hosted'
  localTargets: boolean
}

export type SessionUpdate = Static<typeof schemas.sessionUpdate>
export type SessionRecord = Static<typeof schemas.sessionRecord>
export type SessionStatus = 'ready' | 'attached' | 'detached' | 'stopped'
/** A conversation in a session's timeline, with the coding tool's own title for it. */
export interface Conversation {
  id: string
  startedAt: string
  /** The session that resumed this conversation since; it belongs there now. */
  movedTo: { id: string; name: string } | null
  title: string | null
}
/** A session as Outpost shows it: its stored record, the coding tool's view, and what runs it now. */
export interface Session extends Omit<SessionRecord, 'conversations'> {
  /** Oldest first; the last is the current conversation. */
  conversations: Conversation[]
  /** The tool's title for the current conversation. */
  title: string | null
  status: SessionStatus
  /** What drives the current conversation now: a terminal, chat, or nothing. */
  driver: 'terminal' | 'chat' | null
  /** The configuration revision the running driver started with. */
  runningRevision: number | null
  activity: SessionActivity
}
export const currentConversation = (session: { conversations: { id: string }[] }) => session.conversations.at(-1)!.id

export interface ConversationMatch {
  tool: HarnessId
  conversation: string
  storage: Record<string, string>
  rootDir: string
  title: string
  createdAt: string | null
  updatedAt: string | null
  excerpt: string | null
  managedSessionIds: string[]
}
export interface ConversationResults {
  sessions: ConversationMatch[]
  truncated: boolean
  warnings: string[]
}
export interface DirectorySuggestions {
  directories: string[]
  truncated: boolean
}

/** Chat mode runs Claude Code through its official ACP adapter; Codex's is
 * bundled in Outpost Terminal; Kimi Code and DeepSeek Harness serve ACP themselves. */
export const requiredSoftware = (target: { tools: HarnessId[] }): SoftwareId[] => [
  'bash',
  'outpost-terminal',
  ...target.tools,
  ...(target.tools.includes('claude') ? (['claude-agent-acp'] as const) : []),
]
export interface SoftwareStatus {
  id: SoftwareId
  status: 'installed' | 'missing' | 'broken'
  path: string | null
  version: string | null
  detail: string | null
}
export interface Installation {
  id: string
  softwareId: SoftwareId
  status: 'running' | 'succeeded' | 'failed'
  startedAt: string
  finishedAt: string | null
  exitCode: number | null
  error: string | null
}
export interface SoftwareReport {
  environment: ExecutionEnvironment
  checkedAt: string
  software: SoftwareStatus[]
  installation: Installation | null
}
export interface InstallationPlan {
  softwareId: SoftwareId
  script: string
}
export type InstallationEvent =
  { type: 'output'; text: string } | { type: 'status' | 'complete'; installation: Installation }
