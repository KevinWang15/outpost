// Coding harness registry. The target-side adapters live in runtime/outpost_<id>.py;
// see docs/ARCHITECTURE.md → "Add a coding harness".
const uuid = '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$'

export const harnesses = [
  {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    installer: { url: 'https://claude.ai/install.sh', shell: 'bash' },
    nativeId: uuid,
    storageKey: 'CLAUDE_CONFIG_DIR',
  },
  {
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    installer: { url: 'https://chatgpt.com/codex/install.sh', shell: 'sh' },
    nativeId: uuid,
    storageKey: 'CODEX_HOME',
  },
  {
    id: 'kimi',
    label: 'Kimi Code',
    command: 'kimi',
    installer: { url: 'https://code.kimi.com/kimi-code/install.sh', shell: 'bash' },
    nativeId: '^session_[A-Za-z0-9_-]{1,120}$',
    storageKey: 'KIMI_CODE_HOME',
  },
] as const

export type HarnessId = (typeof harnesses)[number]['id']
export const harnessIds = harnesses.map(harness => harness.id) as HarnessId[]
export const harnessLabel = (id: HarnessId) => harnesses.find(harness => harness.id === id)!.label
