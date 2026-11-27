import type { Static } from 'typebox'
import type { SessionActivity } from './activity'
import { harnessDefinition, harnesses, type HarnessId } from './harnesses'
import { softwareIds } from './schemas'
import type * as schemas from './schemas'

// Inputs and stored records are derived from their validation schemas.
export type ExecutionEnvironment = Static<typeof schemas.environment>
export type TargetInput = Static<typeof schemas.targetInput>
export type OutboundEnrollmentInput = Static<typeof schemas.outboundEnrollment>
export type TargetUpdate = Static<typeof schemas.targetUpdate>
export type Target = Static<typeof schemas.targetRecord>
export const machineSetupLabels = {
  ssh: 'Connect over SSH',
  local: 'On the Outpost server',
  outbound: 'Run setup on the machine',
} as const satisfies Record<Target['kind'], string>

export type SshTarget = Extract<Target, { kind: 'ssh' }>
export type SessionCreationRequest = Static<typeof schemas.desktopSessionCreationInput>
export type SessionInput = Static<typeof schemas.sessionInput>
export type SessionForkInput = Static<typeof schemas.sessionForkInput>
export type ConversationSearch = Static<typeof schemas.conversationSearch>
export type SoftwareId = (typeof softwareIds)[number]
export type InstallationInput = Static<typeof schemas.installationInput>
export interface Environment {
  mode: 'local' | 'hosted'
  localTargets: boolean
}

export type SessionUpdate = Static<typeof schemas.sessionUpdate>
type SessionConfig = Static<typeof schemas.sessionConfig>
/** What a session's coding tool starts with: its configuration, less the revision. */
export type LaunchSettings = Omit<SessionConfig, 'revision'>
export type SessionSettings = Static<typeof schemas.sessionSettings>
export type SessionRecord = Static<typeof schemas.sessionRecord>
type SessionStatus = 'ready' | 'attached' | 'detached' | 'stopped'
/** A conversation in a session's timeline. */
export interface Conversation {
  id: string
  tool: HarnessId
  startedAt: string
  /** The session that resumed this conversation since; it belongs there now. */
  movedTo: { id: string; name: string } | null
}
/** A session as Outpost shows it: its stored record and what runs it now. */
export interface Session extends Omit<SessionRecord, 'conversations'> {
  /** Remembered conversations across harnesses, oldest first. */
  conversations: Conversation[]
  status: SessionStatus
  /** What drives the current session now: a terminal, chat, or nothing. */
  driver: 'terminal' | 'chat' | null
  /** The configuration revision the running driver started with. */
  runningRevision: number | null
  activity: SessionActivity
}

export interface ConversationMatch {
  tool: HarnessId
  conversation: string
  storage: Record<string, string>
  rootDir: string
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

/** Core components required before a machine can run sessions. */
export const coreSoftware: readonly SoftwareId[] = ['bash', 'outpost-terminal']

/** Every software component Outpost inspects on a machine. */
export const allSoftware: readonly SoftwareId[] = softwareIds

/** Components installed when setting up a coding harness. */
export const harnessSoftware = (id: HarnessId): SoftwareId[] => {
  const adapter = harnessDefinition(id).chatAdapter
  return adapter ? [id, adapter] : [id]
}

/** Filter out bundled helper adapters when their parent harness is already listed. */
export const visibleSoftware = (ids: readonly SoftwareId[]): SoftwareId[] =>
  ids.filter(id => !harnesses.some(h => h.chatAdapter === id && ids.includes(h.id)))

/** Deduplicated software IDs ensured by a setup run: always core requirements, plus any requested items. */
export const setupTargets = (requested?: readonly SoftwareId[]): SoftwareId[] => [
  ...new Set<SoftwareId>([...coreSoftware, ...(requested ?? [])]),
]

const systemLabels: Record<string, string> = {
  bash: 'Bash',
  'outpost-terminal': 'Outpost machine service',
  'claude-agent-acp': 'Claude Code chat adapter',
}
/** Software as the interface names it. */
export const softwareLabel = (id: SoftwareId) => harnesses.find(harness => harness.id === id)?.label ?? systemLabels[id]
export interface SoftwareStatus {
  id: SoftwareId
  status: 'installed' | 'missing' | 'broken'
  path: string | null
  version: string | null
  detail: string | null
}
export interface Installation {
  id: string
  software: SoftwareId[]
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
}
export type InstallationEvent =
  { type: 'output'; text: string } | { type: 'status' | 'complete'; installation: Installation }
