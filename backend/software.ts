import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  allSoftware,
  coreSoftware,
  setupTargets,
  softwareLabel,
  visibleSoftware,
  type SoftwareId,
  type SoftwareReport,
} from '../shared/model'
import { inspectionScript, softwareReport } from '../shared/node/softwareInspection'
import { toolInstaller } from '../shared/node/toolInstaller'
import { AppError } from './errors'
import { MachineConnectionError } from './machines'
import { MachineAssets, platformName } from './machineAssets'
import { detectPlatform, sshServiceInstaller, sshToolInstaller } from './machineInstaller'
import { runCommand, type CommandResult } from '../shared/node/process'
import type { TargetContext } from './sessions'

export interface SoftwareService {
  inspect(context: TargetContext, signal?: AbortSignal): Promise<SoftwareReport>
  setup(
    context: TargetContext,
    output: (text: string) => void,
    signal: AbortSignal,
    requested?: readonly SoftwareId[],
  ): Promise<void>
}

export class SoftwareClient implements SoftwareService {
  constructor(
    private assets: MachineAssets,
    private env: NodeJS.ProcessEnv = process.env,
  ) {}

  private async report({ transport, machine }: TargetContext, signal?: AbortSignal, bootstrap = false) {
    const marker = 'OUTPOST_SOFTWARE_' + randomUUID()
    const ids = allSoftware
    const result =
      bootstrap && transport
        ? await runCommand(transport.management('interactive'), inspectionScript(ids, marker, machine.socket), {
            env: this.env,
            signal,
            timeoutMs: 45_000,
            readOnly: true,
          })
        : await machine.call<CommandResult>('software.inspect', { marker }, { signal, timeoutMs: 50_000 })
    try {
      return softwareReport(ids, marker, result)
    } catch (error) {
      throw new AppError((error as Error).message, 502)
    }
  }

  async inspect(context: TargetContext, signal?: AbortSignal) {
    try {
      return await this.report(context, signal, false)
    } catch (error) {
      if (context.transport && !signal?.aborted && error instanceof MachineConnectionError && error.serviceRequired) {
        return this.report(context, signal, true)
      }
      throw error
    }
  }

  async setup(
    context: TargetContext,
    output: (text: string) => void,
    signal: AbortSignal,
    requested?: readonly SoftwareId[],
  ) {
    const { machine, transport } = context
    const targets = setupTargets(requested)
    output('Checking the machine and installed software…\n')
    const initial = await this.report(context, signal, true)
    const missing = initial.software.filter(item => targets.includes(item.id) && item.status !== 'installed')
    const options = { env: this.env, signal, timeoutMs: 15 * 60_000, onOutput: output }
    let platform = ''
    if (transport && missing.length) {
      const result = await runCommand(transport.shell(detectPlatform + '\nprintf "%s" "$platform"'), '', {
        env: this.env,
        signal,
        readOnly: true,
      })
      if (result.code !== 0) throw new Error(result.stderr || 'Could not determine machine platform.')
      platform = platformName(result.stdout.trim())
    }
    for (const { id } of missing) {
      signal.throwIfAborted()
      output('Installing ' + softwareLabel(id) + '…\n')
      let result: CommandResult
      if (id === 'outpost-terminal') {
        if (!transport) throw new AppError('Run the machine setup command again to update the outbound service.', 409)
        const asset = await this.assets.service(platform)
        result = await runCommand(
          transport.shell(sshServiceInstaller(machine.socket, asset.sha256)),
          createReadStream(asset.path),
          options,
        )
        if (result.code === 0) machine.restart()
      } else if (transport) {
        const asset = await this.assets.approvedTool(platform, id)
        result = asset
          ? await runCommand(transport.shell(sshToolInstaller(asset.sha256)), createReadStream(asset.path), options)
          : await runCommand(transport.management('noninteractive'), toolInstaller(id), options)
      } else {
        result = await machine.call<CommandResult>(
          'software.install',
          { id },
          { timeoutMs: options.timeoutMs + 5000, signal },
        )
        output(result.stdout + result.stderr)
      }
      if (result.code !== 0)
        throw new Error('Installation failed for ' + softwareLabel(id) + '. Review the setup log and retry.')
    }
    const verified = await this.inspect(context, signal)
    const remaining = verified.software.filter(item => targets.includes(item.id) && item.status !== 'installed')
    if (remaining.length)
      throw new Error('Check the installation of ' + remaining.map(item => softwareLabel(item.id)).join(', ') + '.')
    await context.workspace.setEnvironment(context.target.id, verified.environment)
    const done = visibleSoftware(requested?.length ? requested : coreSoftware)
    output(
      requested?.length
        ? `${done.map(softwareLabel).join(', ')} ${done.length === 1 ? 'is' : 'are'} ready.\n`
        : 'The machine service is ready.\n',
    )
  }
}
