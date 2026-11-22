import { toolInstaller } from '../shared/node/toolInstaller'
import { locked } from './state'
import { runCommand } from '../backend/process'
import { loginShell } from '../shared/node/loginShell'
import type { SoftwareId } from '../shared/model'
import { inspectionScript } from '../shared/node/softwareInspection'

/** Inspect the current machine from its execution account's interactive login shell. */
export function inspectSoftware(ids: SoftwareId[], marker: string) {
  return runCommand(
    { executable: 'sh', args: ['-c', loginShell('interactive')], label: 'Software inspection' },
    inspectionScript(ids, marker),
    { timeoutMs: 45000, maxOutputBytes: 256 * 1024 },
  )
}

export function installTool(id: SoftwareId) {
  return locked('software-install', () =>
    runCommand(
      { executable: 'sh', args: ['-c', loginShell('noninteractive')], label: 'Software installation' },
      toolInstaller(id),
      { timeoutMs: 15 * 60_000, maxOutputBytes: 256 * 1024 },
    ),
  )
}
