import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SshTarget, TerminalShell } from '../shared/session-manager'
import type { Command } from './process'
import type { SessionTransport } from './transport'
import { loginScriptShell, quote } from './shell'
import { managedSshIdentity } from './account-ssh'

const expandHome = (value: string) => /^~[/\\]/.test(value) ? join(homedir(), value.slice(2)) : value

export function sshArgs(target: SshTarget, interactive = false) {
  const args = [interactive ? '-tt' : '-T', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3', '-o', 'StrictHostKeyChecking=accept-new']
  if (!interactive) args.push('-o', 'BatchMode=yes')
  if (target.port) args.push('-p', String(target.port))
  const identity = !interactive && managedSshIdentity(target)
  if (identity) {
    const knownHosts = identity.knownHostsFile.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')
    args.push('-F', 'none', '-o', 'IdentityAgent=none', '-o', 'IdentitiesOnly=yes',
      '-o', 'ForwardAgent=no', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
      '-o', `UserKnownHostsFile="${knownHosts}"`, '-o', 'GlobalKnownHostsFile=none', '-i', identity.identityFile)
  } else if (target.identityFile) args.push('-i', interactive ? target.identityFile : expandHome(target.identityFile))
  args.push('-l', 'root', '--', target.host)
  return args
}

export class SshTransport implements SessionTransport {
  readonly shells: readonly TerminalShell[] = ['bash', 'powershell', 'cmd']
  readonly rootRequired = true
  constructor(private target: SshTarget) {}
  script(): Command { return { executable: 'ssh', args: [...sshArgs(this.target), `sh -c ${quote(loginScriptShell)}`], label: 'SSH' } }
  attach(operation: string): Command {
    const shell = this.target.environment ? quote(this.target.environment.shell) : 'bash'
    return { executable: 'ssh', args: [...sshArgs(this.target, true), `${shell} -lic ${quote(operation)}`], label: 'SSH', expandHome: true }
  }
}
