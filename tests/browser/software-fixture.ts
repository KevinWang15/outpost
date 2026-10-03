import type { CodingTool, ExecutionEnvironment, SessionBackend, SoftwareReport } from '../../shared/session-manager'
import { requiredSoftware } from '../../shared/session-manager'
export const executionEnvironment: ExecutionEnvironment = { home: '/root', username: 'root', uid: 0, platform: 'linux', shell: '/bin/bash' }
export function healthySoftware(backends: SessionBackend[] = ['tmux'], tools: CodingTool[] = ['codex', 'kimi', 'claude'], environment = executionEnvironment): SoftwareReport {
  return { environment, checkedAt: '2026-09-30T00:00:00Z', installation: null,
    software: requiredSoftware({ backends, tools }, environment.platform).map(id => ({ id, status: 'installed', path: `/usr/bin/${id}`, version: `${id} 1.0`, detail: null })) }
}
