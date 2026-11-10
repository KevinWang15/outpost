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

export interface SessionLaunchOptions {
  env: Record<string, string>
  args: string
}
export type SessionStatus = 'ready' | 'attached' | 'detached' | 'stopped'
export interface Session extends SessionLaunchOptions {
  id: string
  name: string
  tool: HarnessId
  rootDir: string
  cliSessionId: string
  cliSessionEnv: Record<string, string>
  createdAt: string
  lastConnectedAt: string | null
  status: SessionStatus
  /** What drives the native conversation now: a terminal, chat, or nothing. */
  driver: 'terminal' | 'chat' | null
  activity: SessionActivity
  /** Chat-mode session instructions, appended to the agent's system prompt. */
  instructions: string | null
}
export interface SessionList {
  sessions: Session[]
  registryPath: string
}

export interface ConversationMatch {
  tool: HarnessId
  cliSessionId: string
  cliSessionEnv: Record<string, string>
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
 * bundled in Outpost Terminal and Kimi Code serves ACP itself. */
export const requiredSoftware = (target: { tools: HarnessId[] }): SoftwareId[] => [
  'bash',
  'python3',
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
