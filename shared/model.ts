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
export type SessionImageInput = Static<typeof schemas.imageInput>
export type ConversationSearch = Static<typeof schemas.conversationSearch>
export type ImageMediaType = SessionImageInput['mediaType']
export type SoftwareId = (typeof schemas.softwareIds)[number]
// Runtime constants stay here so the browser bundle never loads TypeBox.
export const imageMediaTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

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
  activity: SessionActivity
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

export const imageExtensions: Record<ImageMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}
export const maxImageBytes = 16 * 1024 * 1024
export interface SessionImage {
  path: string
  reference: string
  injected: boolean
}

export const requiredSoftware = (target: { tools: HarnessId[] }): SoftwareId[] => [
  'bash',
  'python3',
  'tmux',
  ...target.tools,
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
