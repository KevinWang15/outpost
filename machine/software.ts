import { runCommand } from '../backend/process'
import { loginScriptShell } from '../backend/shell'
import type { SoftwareId } from '../shared/model'
import { inspectionScript } from '../shared/node/softwareInspection'

/** Inspect the current machine from its execution account's interactive login shell. */
export function inspectSoftware(ids: SoftwareId[], marker: string) {
  return runCommand(
    { executable: 'sh', args: ['-c', loginScriptShell('interactive')], label: 'Software inspection' },
    inspectionScript(ids, marker),
    { timeoutMs: 45000, maxOutputBytes: 256 * 1024 },
  )
}
