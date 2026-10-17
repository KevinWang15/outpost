import type { CloseScope } from './workspace-model'

interface Host<Pane extends { id: number }> {
  resolve(scope: CloseScope): readonly Pane[]
  confirm(scope: CloseScope, panes: readonly Pane[]): Promise<boolean>
  dispose(pane: Pane): void
  settled(): void
}
export type CloseResult = 'closed' | 'cancelled' | 'busy' | 'empty'

/** One confirmation policy for pane, tab and window lifetimes. Consent applies
 * only to the captured terminals that still belong to that exact scope. */
export class WorkspaceClose<Pane extends { id: number }> {
  private pending = false
  constructor(private host: Host<Pane>) {}

  async request(scope: CloseScope): Promise<CloseResult> {
    if (this.pending) return 'busy'
    const panes = [...this.host.resolve(scope)]
    if (!panes.length) return 'empty'
    this.pending = true
    try {
      if (!(await this.host.confirm(scope, panes))) return 'cancelled'
      for (const pane of panes) {
        // A renderer may exit, or a launch/transfer may change membership while
        // the native confirmation is open. Never expand or redirect its scope.
        if (this.host.resolve(scope).includes(pane)) this.host.dispose(pane)
      }
      return 'closed'
    } finally {
      this.pending = false
      this.host.settled()
    }
  }
}
