import type { DesktopSessionChoice } from '../../shared/desktopAuth'
import type { SessionFinderState } from './session-finder-api'
import type { SessionCatalogue } from './server-catalogue'

export interface SessionFinderActions {
  load(
    signal: AbortSignal,
    publish: (catalogue: SessionCatalogue) => void,
    previous: DesktopSessionChoice[],
  ): Promise<void>
  create(): Promise<DesktopSessionChoice | null>
  open(session: DesktopSessionChoice, signal: AbortSignal): Promise<void>
}
interface Host extends SessionFinderActions {
  changed(state: SessionFinderState): void
  finished(error?: Error): void
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** One lifetime owns discovery, creation and connection. Confirmed creates are
 * immediately selectable; only a successful open resolves the flow. */
export class SessionFinderFlow {
  state: SessionFinderState
  private settled = false
  private lifetime = new AbortController()
  private discovery: AbortController | null = null
  private created = new Map<string, DesktopSessionChoice>()

  constructor(
    title: string,
    private host: Host,
  ) {
    this.state = { title, revision: 0, sessions: [], errors: [], loading: true, busy: 'idle', actionError: null }
  }
  private update(next: Partial<Omit<SessionFinderState, 'revision'>>) {
    if (this.settled) return
    this.state = { ...this.state, ...next, revision: this.state.revision + 1 }
    this.host.changed(this.state)
  }
  async refresh() {
    if (this.settled || this.state.busy !== 'idle') return
    this.discovery?.abort()
    const controller = new AbortController()
    this.discovery = controller
    const current = () => !this.settled && this.discovery === controller && !controller.signal.aborted
    this.update({ loading: true, errors: [] })
    try {
      await this.host.load(
        controller.signal,
        catalogue => {
          if (!current()) return
          // Keep confirmed creates first, including when a lagging server returns a
          // list without them. This pin lasts only for this picker invocation.
          const sessions = new Map(this.created)
          for (const session of catalogue.sessions) sessions.set(session.id, session)
          this.update({ ...catalogue, sessions: [...sessions.values()] })
        },
        this.state.sessions,
      )
    } catch (error) {
      if (current()) this.update({ errors: [message(error)] })
    } finally {
      if (current()) this.update({ loading: false })
    }
  }
  async create() {
    if (this.settled || this.state.busy !== 'idle') return
    this.discovery?.abort()
    this.update({ busy: 'creating', actionError: null, loading: false })
    try {
      const session = await this.host.create()
      if (this.settled) return
      if (session) {
        this.created.set(session.id, session)
        this.update({
          sessions: [session, ...this.state.sessions.filter(item => item.id !== session.id)],
          focusId: session.id,
        })
      }
    } catch (error) {
      this.update({ actionError: message(error) })
    } finally {
      if (!this.settled) {
        this.update({ busy: 'idle' })
        // Also refresh after cancellation: a create response may have been lost.
        void this.refresh()
      }
    }
  }
  async choose(id: string) {
    if (this.settled || this.state.busy !== 'idle') return
    const session = this.state.sessions.find(item => item.id === id)
    if (!session) return
    this.update({ busy: 'connecting', actionError: null })
    try {
      await this.host.open(session, this.lifetime.signal)
      if (!this.settled) this.finish()
    } catch (error) {
      if (!this.settled) this.update({ busy: 'idle', actionError: message(error) })
    }
  }
  finish(error?: Error) {
    if (this.settled) return
    this.settled = true
    this.lifetime.abort()
    this.discovery?.abort()
    this.host.finished(error)
  }
}
