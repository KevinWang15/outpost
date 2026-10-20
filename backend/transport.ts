import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Target } from '../shared/model'
import type { Command, CommandResult } from './process'
import { AppError } from './errors'
import { loginScriptShell, quote, type LoginMode } from './shell'

/** Hosted accounts connect with their own key and known hosts; local mode uses OpenSSH defaults. */
export interface SshIdentity {
  identityFile: string
  knownHostsFile: string
}

/** How commands reach a target. Software management reads a POSIX script on
 * stdin; runtime operations use a short command with their payload on stdin. */
export interface Transport {
  readonly label: string
  management(mode: LoginMode): Command
  runtime(operation: string): Command
}

export interface TransportOptions {
  /** Directory for OpenSSH connection sharing on supported hosts; omit to disable. */
  multiplex?: string
  /** Distinguishes owners so connection sharing never crosses accounts. */
  scope: string
}

// The SSH client runs on the backend host, independently of the desktop and
// target platforms. Native Windows OpenSSH does not support ControlMaster.
export const supportsSshMultiplexing = () => process.platform !== 'win32'

const expandHome = (value: string) => (value.startsWith('~/') ? join(homedir(), value.slice(2)) : value)

const multiplexDiagnostics = [
  /^Failed to connect to new control master$/,
  /^Control master terminated unexpectedly$/,
  /^mux_client_[a-z_]+: (?:read from master failed|read packet failed|write packet:|send fds failed|master alive request failed)(?::? .*)?$/,
  /^muxclient: master hello exchange failed$/,
]

function multiplexFailure({ code, stdout, stderr }: CommandResult): boolean {
  if (code !== 255 || stdout.length !== 0) return false
  const diagnostics = stderr
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  // OpenSSH may already have fallen back after a mux error. Require every
  // diagnostic to describe a mux failure so a later authentication/configuration
  // error is preserved. Unknown or mixed diagnostics fail closed in any order.
  return diagnostics.length > 0 && diagnostics.every(line => multiplexDiagnostics.some(pattern => pattern.test(line)))
}

export function sshArgs(
  target: Extract<Target, { kind: 'ssh' }>,
  identity: SshIdentity | null,
  options: TransportOptions,
) {
  const args = [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-e',
    'none',
  ]
  if (target.port) args.push('-p', String(target.port))
  if (identity) {
    const knownHosts = identity.knownHostsFile.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')
    args.push(
      '-F',
      'none',
      '-o',
      'IdentityAgent=none',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'ForwardAgent=no',
      '-o',
      'PasswordAuthentication=no',
      '-o',
      'KbdInteractiveAuthentication=no',
      '-o',
      `UserKnownHostsFile="${knownHosts}"`,
      '-o',
      'GlobalKnownHostsFile=none',
      '-i',
      identity.identityFile,
    )
  } else if (target.identityFile) args.push('-i', expandHome(target.identityFile))
  if (options.multiplex && supportsSshMultiplexing()) {
    // Shared masters authenticate once. Scope them by owner and identity so a
    // connection opened with one credential is never reused by another.
    const scope = createHash('sha256')
      .update(JSON.stringify([options.scope, identity?.identityFile ?? target.identityFile ?? '']))
      .digest('hex')
      .slice(0, 12)
    args.push(
      '-o',
      'ControlMaster=auto',
      '-o',
      `ControlPath=${join(options.multiplex, `${scope}-%C`)}`,
      '-o',
      'ControlPersist=120',
    )
  } else {
    // ControlMaster=no alone still permits using a configured ControlPath.
    // Explicitly override all sharing options, including ~/.ssh/config.
    args.push('-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no')
  }
  args.push('-l', 'root', '--', target.host)
  return args
}

class SshTransport implements Transport {
  readonly label = 'SSH'
  constructor(
    private target: Extract<Target, { kind: 'ssh' }>,
    private identity: SshIdentity | null,
    private options: TransportOptions,
  ) {}
  private command(operation: string): Command {
    const command: Command = {
      executable: 'ssh',
      args: [...sshArgs(this.target, this.identity, this.options), operation],
      label: this.label,
    }
    if (this.options.multiplex && supportsSshMultiplexing()) {
      command.retry = {
        args: [...sshArgs(this.target, this.identity, { scope: this.options.scope }), operation],
        when: multiplexFailure,
      }
    }
    return command
  }
  management(mode: LoginMode): Command {
    return this.command(`sh -c ${quote(loginScriptShell(mode))}`)
  }
  runtime(operation: string): Command {
    const shell = this.target.environment ? quote(this.target.environment.shell) : 'bash'
    return this.command(`${shell} -lic ${quote(operation)}`)
  }
}

/** The same commands as SSH, run as the Outpost server's own user. */
class LocalTransport implements Transport {
  readonly label = 'Local shell'
  constructor(private target: Extract<Target, { kind: 'local' }>) {
    if (process.platform !== 'linux')
      throw new AppError('Local targets require the Outpost server to run on Linux.', 409)
  }
  management(mode: LoginMode): Command {
    return { executable: 'sh', args: ['-c', loginScriptShell(mode)], label: this.label }
  }
  runtime(operation: string): Command {
    return { executable: this.target.environment?.shell ?? 'bash', args: ['-lic', operation], label: this.label }
  }
}

export function transportFor(target: Target, identity: SshIdentity | null, options: TransportOptions): Transport {
  switch (target.kind) {
    case 'ssh':
      return new SshTransport(target, identity, options)
    case 'local':
      return new LocalTransport(target)
  }
}
