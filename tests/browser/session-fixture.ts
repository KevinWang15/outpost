import { createHash } from 'node:crypto'
import type { CodingTool } from '../../shared/session-manager'

export function codingIdentity(tool: CodingTool, managerId: string) {
  const hash = createHash('sha256').update(`${tool}:${managerId}`).digest('hex')
  const uuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
  const key = { codex: 'CODEX_HOME', claude: 'CLAUDE_CONFIG_DIR', kimi: 'KIMI_CODE_HOME' }[tool]
  const home = { codex: '.codex', claude: '.claude', kimi: '.kimi-code' }[tool]
  return { cliSessionId: tool === 'kimi' ? `session_${uuid.replaceAll('-', '')}` : uuid, cliSessionEnv: { [key]: `/root/${home}` } }
}
