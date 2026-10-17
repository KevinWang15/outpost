import type { HarnessId } from './harnesses'
import type { SoftwareId, SoftwareStatus } from './model'

export interface SessionCreationOptions {
  tools: HarnessId[]
  missing: SoftwareId[]
}

/** The web workspace and desktop creator use the same readiness criteria. */
export function sessionCreationOptions(
  target: { tools: HarnessId[] },
  software: SoftwareStatus[],
): SessionCreationOptions {
  const installed = new Set(software.filter(item => item.status === 'installed').map(item => item.id))
  const tools = target.tools.filter(tool => installed.has(tool))
  const required: SoftwareId[] = ['bash', 'python3', 'outpost-terminal']
  return {
    tools,
    missing: [...required.filter(id => !installed.has(id)), ...(tools.length ? [] : target.tools)],
  }
}
