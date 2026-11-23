import { harnessIds, type HarnessId } from './harnesses'
import { coreSoftware, type SoftwareId, type SoftwareStatus } from './model'

export interface SessionCreationOptions {
  /** Coding harnesses detected as installed on the machine. */
  tools: HarnessId[]
  /** Core machine requirements that are missing or broken. */
  missing: SoftwareId[]
}

/** The web workspace, chat and desktop creator use the same readiness criteria. */
export function sessionCreationOptions(software: SoftwareStatus[]): SessionCreationOptions {
  const installed = new Set(software.filter(item => item.status === 'installed').map(item => item.id))
  return {
    tools: harnessIds.filter(tool => installed.has(tool)),
    missing: coreSoftware.filter(id => !installed.has(id)),
  }
}
