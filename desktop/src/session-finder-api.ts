import type { DesktopSessionChoice } from '../../shared/desktopAuth'

/** Only display metadata crosses into the finder; reconnect credentials stay native. */
export interface SessionFinderState {
  revision: number
  title: string
  sessions: DesktopSessionChoice[]
  errors: string[]
  loading: boolean
  busy: 'idle' | 'creating' | 'connecting'
  actionError: string | null
  focusId?: string
}
export interface SessionFinderBridge {
  state(): Promise<SessionFinderState>
  onState(listener: (state: SessionFinderState) => void): () => void
  choose(id: string): void
  create(): void
  refresh(): void
  cancel(): void
}

declare global {
  interface Window {
    outpostSessionFinder: SessionFinderBridge
  }
}
