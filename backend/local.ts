import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { LocalTarget, TerminalShell } from '../shared/session-manager'
import { AppError } from './errors'
import type { SessionTransport } from './transport'
import type { Command } from './process'
import { loginScriptShell } from './shell'

const execute = promisify(execFile)
export const localEnvironment = () => ({ platform: process.platform, supported: ['linux', 'darwin', 'win32'].includes(process.platform), usesWsl: process.platform === 'win32' })

// Pin the selected distribution, including when the user chooses the default.
export async function localDistribution(distribution?: string) {
  if (process.platform !== 'win32') {
    if (distribution) throw new AppError('WSL distributions are only supported on Windows', 400)
    if (!localEnvironment().supported) throw new AppError('Local sessions require Linux, macOS, or Windows with WSL', 400)
    return undefined
  }
  try {
    const { stdout } = await execute('wsl.exe', [...(distribution ? ['--distribution', distribution] : []), '--exec', 'sh', '-c', 'printf "%s" "$WSL_DISTRO_NAME"'], { timeout: 30_000, maxBuffer: 16_000, windowsHide: true })
    const name = stdout.trim()
    if (!name || [...name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error('No distribution name returned')
    return name
  } catch {
    throw new AppError('Could not open the WSL distribution. Install and start WSL, check the distribution name, then retry.', 400)
  }
}

export class LocalTransport implements SessionTransport {
  readonly rootRequired = false
  get shells(): readonly TerminalShell[] { return this.platform === 'win32' ? ['powershell', 'cmd'] : ['bash'] }
  get context() { return this.target.environment ? { home: this.target.environment.home, uid: this.target.environment.uid } : undefined }
  constructor(private target: LocalTarget, private platform = process.platform) {
    if (!['linux', 'darwin', 'win32'].includes(platform)) throw new AppError('Unsupported local platform', 400)
    if (platform === 'win32' && !target.distribution) throw new AppError('Select a WSL distribution when adding this local target', 409)
  }
  private command(executable: string, args: string[]): Command {
    if (this.platform !== 'win32') return { executable, args, label: 'Local shell' }
    return { executable: 'wsl.exe', args: ['--distribution', this.target.distribution!,
      ...(this.target.environment ? ['--user', this.target.environment.username] : []), '--exec', executable, ...args], label: 'WSL' }
  }
  script() { return this.command('sh', ['-c', loginScriptShell]) }
  attach(operation: string) {
    if (!this.target.environment) throw new AppError('Check Required Software before connecting to a local session', 409)
    return this.command(this.target.environment.shell, ['-lic', operation])
  }
}
