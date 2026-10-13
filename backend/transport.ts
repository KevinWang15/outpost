import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Target } from '../shared/model'
import type { Command } from './process'
import { AppError } from './errors'
import { loginScriptShell, quote } from './shell'

/** Hosted accounts connect with their own key and known hosts; local mode uses OpenSSH defaults. */
export interface SshIdentity { identityFile: string; knownHostsFile: string }

/** How commands reach a target. Management operations read a POSIX script on
 * stdin; attachments run one runtime operation with stdio as the relay channel. */
export interface Transport {
  readonly label: string
  management(): Command
  attach(operation: string): Command
}

export interface TransportOptions {
  /** Directory for OpenSSH connection sharing; omit to disable. */
  multiplex?: string
  /** Distinguishes owners so connection sharing never crosses accounts. */
  scope: string
}

const expandHome = (value: string) => value.startsWith('~/') ? join(homedir(), value.slice(2)) : value

export function sshArgs(target: Extract<Target, { kind: 'ssh' }>, identity: SshIdentity | null, options: TransportOptions) {
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3', '-o', 'StrictHostKeyChecking=accept-new', '-e', 'none']
  if (target.port) args.push('-p', String(target.port))
  if (identity) {
    const knownHosts = identity.knownHostsFile.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')
    args.push('-F', 'none', '-o', 'IdentityAgent=none', '-o', 'IdentitiesOnly=yes',
      '-o', 'ForwardAgent=no', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
      '-o', `UserKnownHostsFile="${knownHosts}"`, '-o', 'GlobalKnownHostsFile=none', '-i', identity.identityFile)
  } else if (target.identityFile) args.push('-i', expandHome(target.identityFile))
  if (options.multiplex) {
    // Shared masters authenticate once. Scope them by owner and identity so a
    // connection opened with one credential is never reused by another.
    const scope = createHash('sha256').update(JSON.stringify([options.scope, identity?.identityFile ?? target.identityFile ?? ''])).digest('hex').slice(0, 12)
    args.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${join(options.multiplex, `${scope}-%C`)}`, '-o', 'ControlPersist=120')
  }
  args.push('-l', 'root', '--', target.host)
  return args
}

class SshTransport implements Transport {
  readonly label = 'SSH'
  constructor(private target: Extract<Target, { kind: 'ssh' }>, private identity: SshIdentity | null, private options: TransportOptions) {}
  management(): Command { return { executable: 'ssh', args: [...sshArgs(this.target, this.identity, this.options), `sh -c ${quote(loginScriptShell)}`], label: 'SSH' } }
  attach(operation: string): Command {
    const shell = this.target.environment ? quote(this.target.environment.shell) : 'bash'
    return { executable: 'ssh', args: [...sshArgs(this.target, this.identity, this.options), `${shell} -lic ${quote(operation)}`], label: 'SSH' }
  }
}

/** The same commands as SSH, run as the Outpost server's own user. */
class LocalTransport implements Transport {
  readonly label = 'Local shell'
  constructor(private target: Extract<Target, { kind: 'local' }>) {
    if (process.platform !== 'linux') throw new AppError('Local targets require the Outpost server to run on Linux.', 409)
  }
  management(): Command { return { executable: 'sh', args: ['-c', loginScriptShell], label: this.label } }
  attach(operation: string): Command { return { executable: this.target.environment?.shell ?? 'bash', args: ['-lic', operation], label: this.label } }
}

export function transportFor(target: Target, identity: SshIdentity | null, options: TransportOptions): Transport {
  switch (target.kind) {
    case 'ssh': return new SshTransport(target, identity, options)
    case 'local': return new LocalTransport(target)
  }
}
