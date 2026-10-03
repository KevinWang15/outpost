export type SessionBackend = 'tmux' | 'dtach'
export type CodingTool = 'codex' | 'kimi' | 'claude'
export const codingToolLabels: Record<CodingTool, string> = { codex: 'Codex', kimi: 'Kimi', claude: 'Claude' }
export interface TargetRequirements { backends: SessionBackend[]; tools: CodingTool[] }
interface TargetBase extends TargetRequirements { name: string }
export interface SshTargetInput extends TargetBase {
  kind: 'ssh'
  host: string
  port?: number
  identityFile?: string
}
export interface LocalTargetInput extends TargetBase { kind: 'local'; distribution?: string }
export type TargetInput = SshTargetInput | LocalTargetInput
export interface ExecutionEnvironment {
  home: string
  platform: 'linux' | 'darwin'
  username: string
  uid: number
  shell: string
}
interface TargetMetadata { id: string; createdAt: string; environment?: ExecutionEnvironment }
export type SshTarget = SshTargetInput & TargetMetadata
export type LocalTarget = LocalTargetInput & TargetMetadata
export type Target = SshTarget | LocalTarget
export interface LocalEnvironment { platform: string; supported: boolean; usesWsl: boolean }
export interface SessionLaunchOptions { env: Record<string, string>; args: string }
export interface SessionActivity {
  state: 'working' | 'idle' | 'finished'
  updatedAt: string | null
  completionId: string | null
  detail: string | null
}
export interface Session extends SessionLaunchOptions {
  backend: SessionBackend
  tool: CodingTool
  id: string
  cliSessionId: string
  cliSessionEnv: Record<string, string>
  name: string
  rootDir: string
  createdAt: string
  lastConnectedAt: string | null
  socketPath: string
  status: 'idle' | 'attached' | 'detached' | 'stopped'
  activity: SessionActivity
}
export interface SessionInput extends Partial<SessionLaunchOptions> { name: string; rootDir: string; backend: SessionBackend; tool: CodingTool; createDirectory?: boolean; cliSessionId?: string; cliSessionEnv?: Record<string, string> }
export interface SessionList { sessions: Session[]; registryPath: string }
export interface CodingSessionSearchInput { query: string; tool?: CodingTool }
export interface CodingSessionMatch {
  tool: CodingTool
  cliSessionId: string
  cliSessionEnv: Record<string, string>
  rootDir: string
  title: string
  createdAt: string | null
  updatedAt: string | null
  excerpt: string | null
  managedSessionIds: string[]
}
export interface CodingSessionSearchResults { sessions: CodingSessionMatch[]; truncated: boolean; warnings: string[] }
export const imageMediaTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export const maxImageBytes = 16 * 1024 * 1024
export interface SessionImageInput { data: string; mediaType: typeof imageMediaTypes[number] }
export interface SessionImage { path: string; reference: string; injected: boolean }
export interface DirectorySuggestions { directories: string[]; truncated: boolean }
export type TerminalShell = 'bash' | 'powershell' | 'cmd'
export interface Connection { commands: Partial<Record<TerminalShell, string>>; expiresAt: string; desktop: import('./terminals').DesktopAvailability; hosted?: boolean }
export type SoftwareId = CodingTool | SessionBackend | 'bash' | 'python3' | 'lsof'
export const softwareLabels: Record<SoftwareId, string> = { ...codingToolLabels, tmux: 'tmux', dtach: 'dtach', bash: 'Bash', python3: 'Python 3', lsof: 'lsof' }
export function requiredSoftware(target: TargetRequirements, platform: ExecutionEnvironment['platform']): SoftwareId[] {
  return ['bash', 'python3', ...target.backends,
    ...(platform === 'darwin' && target.backends.includes('dtach') ? ['lsof' as const] : []),
    ...target.tools]
}
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
export interface InstallationPlan { softwareId: SoftwareId; script: string }
export type InstallationEvent = { type: 'output'; text: string }
  | { type: 'status' | 'complete'; installation: Installation }
