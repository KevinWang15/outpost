import type { Target, TerminalShell } from '../shared/session-manager'
import type { Command } from './process'
import { LocalTransport } from './local'
import { SshTransport } from './ssh'

export interface SessionTransport {
  readonly shells: readonly TerminalShell[]
  readonly rootRequired: boolean
  readonly context?: { home: string; uid: number }
  script(): Command
  attach(operation: string): Command
}

export function transportFor(target: Target): SessionTransport {
  switch (target.kind) {
    case 'ssh': return new SshTransport(target)
    case 'local': return new LocalTransport(target)
  }
}
