import type { Target, TerminalShell } from '../shared/session-manager'
import type { Command } from './process'
import { LocalTransport } from './local'
import { SshTransport } from './ssh'
import { managedSshIdentity } from './account-ssh'
import { AppError } from './errors'

export interface SessionTransport {
  readonly shells: readonly TerminalShell[]
  readonly rootRequired: boolean
  readonly context?: { home: string; uid: number }
  script(): Command
  attach(operation: string): Command
}

export function transportFor(target: Target, requireAccountIdentity = false): SessionTransport {
  // Hosted management must fail closed if account context is lost before execution.
  if (requireAccountIdentity && (target.kind !== 'ssh' || !managedSshIdentity(target))) throw new AppError('Account SSH access is unavailable for this target.', 403)
  switch (target.kind) {
    case 'ssh': return new SshTransport(target)
    case 'local': return new LocalTransport(target)
  }
}
