// Coding harness registry, shared by the UI, the server and the machine adapters
// in machine/harnesses/<id>.ts; see docs/ARCHITECTURE.md → "Add a coding harness".
const uuid = '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$'

export const harnesses = [
  {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    installer: { url: 'https://claude.ai/install.sh', shell: 'bash' },
    nativeId: uuid,
    storageKey: 'CLAUDE_CONFIG_DIR',
    storageDirectory: '.claude',
  },
  {
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    installer: { url: 'https://chatgpt.com/codex/install.sh', shell: 'sh' },
    nativeId: uuid,
    storageKey: 'CODEX_HOME',
    storageDirectory: '.codex',
  },
  {
    id: 'kimi',
    label: 'Kimi Code',
    command: 'kimi',
    installer: { url: 'https://code.kimi.com/kimi-code/install.sh', shell: 'bash' },
    nativeId: '^session_[A-Za-z0-9_-]{1,120}$',
    storageKey: 'KIMI_CODE_HOME',
    storageDirectory: '.kimi-code',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek Harness',
    command: 'dsh',
    installer: { npm: '@deepseek-ai/dsh@0.2.2-rc.1' },
    nativeId: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$',
    storageKey: 'DSH_HOME',
    storageDirectory: '.dsh',
    terminal: false,
  },
] as const

export type HarnessId = (typeof harnesses)[number]['id']
export const harnessIds = harnesses.map(harness => harness.id) as HarnessId[]
export const isHarnessId = (value: unknown): value is HarnessId =>
  typeof value === 'string' && (harnessIds as string[]).includes(value)
export const harnessLabel = (id: HarnessId) => harnesses.find(harness => harness.id === id)!.label
export const supportsTerminal = (id: HarnessId) => {
  const harness = harnesses.find(harness => harness.id === id)!
  return !('terminal' in harness && harness.terminal === false)
}
