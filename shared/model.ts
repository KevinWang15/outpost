import type { HarnessId } from './harnesses'

export interface ExecutionEnvironment { home: string; username: string; uid: number; shell: string }

interface TargetBase { name: string; tools: HarnessId[] }
export interface SshTargetInput extends TargetBase { kind: 'ssh'; host: string; port?: number; identityFile?: string }
export interface LocalTargetInput extends TargetBase { kind: 'local' }
export type TargetInput = SshTargetInput | LocalTargetInput
export interface TargetUpdate { name?: string; tools?: HarnessId[] }
interface TargetMetadata { id: string; createdAt: string; environment?: ExecutionEnvironment }
export type SshTarget = SshTargetInput & TargetMetadata
export type LocalTarget = LocalTargetInput & TargetMetadata
export type Target = SshTarget | LocalTarget

export interface Environment { mode: 'local' | 'hosted'; localTargets: boolean }

export interface SessionLaunchOptions { env: Record<string, string>; args: string }
export interface SessionActivity {
  state: 'working' | 'idle' | 'finished'
  updatedAt: string | null
  completionId: string | null
  detail: string | null
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
export interface SessionInput extends Partial<SessionLaunchOptions> {
  name: string; rootDir: string; tool: HarnessId; createDirectory?: boolean
  cliSessionId?: string; cliSessionEnv?: Record<string, string>
}
export interface SessionList { sessions: Session[]; registryPath: string }

export interface ConversationSearch { query: string; tool?: HarnessId }
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
export interface ConversationResults { sessions: ConversationMatch[]; truncated: boolean; warnings: string[] }
export interface DirectorySuggestions { directories: string[]; truncated: boolean }

export const imageMediaTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type ImageMediaType = typeof imageMediaTypes[number]
export const imageExtensions: Record<ImageMediaType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
export const maxImageBytes = 16 * 1024 * 1024
export interface SessionImageInput { data: string; mediaType: ImageMediaType }
export interface SessionImage { path: string; reference: string; injected: boolean }

export type SoftwareId = HarnessId | 'bash' | 'python3' | 'tmux'
export const requiredSoftware = (target: { tools: HarnessId[] }): SoftwareId[] => ['bash', 'python3', 'tmux', ...target.tools]
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
export interface SoftwareReport { environment: ExecutionEnvironment; checkedAt: string; software: SoftwareStatus[]; installation: Installation | null }
export interface InstallationPlan { softwareId: SoftwareId; script: string }
export type InstallationEvent = { type: 'output'; text: string } | { type: 'status' | 'complete'; installation: Installation }
