import type { DesktopAccount, DesktopTarget } from './desktopAuth'
import type { DirectorySuggestions, SessionInput } from './model'
import type { SessionCreationOptions } from './sessionCreation'
import type { Static } from 'typebox'
import type { desktopSessionCreationInput } from './schemas'

export interface SessionCreatorServerSummary {
  origin: string
  account: DesktopAccount
}
export interface SessionCreationSelection {
  server: string
  targetId: string
}
export type SessionCreationRequest = Static<typeof desktopSessionCreationInput>
export interface SessionCreatorSetup {
  servers: SessionCreatorServerSummary[]
  defaults: { server?: string; targetId?: string }
}
/** Only form data crosses this bridge. Credentials and destination panes stay native. */
export interface SessionCreatorBridge {
  setup(): Promise<SessionCreatorSetup>
  targets(server: string): Promise<DesktopTarget[]>
  options(selection: SessionCreationSelection): Promise<SessionCreationOptions>
  directories(selection: SessionCreationSelection, path: string): Promise<DirectorySuggestions>
  create(selection: SessionCreationSelection, input: SessionInput): Promise<void>
  cancel(): void
}
declare global {
  interface Window {
    outpostSessionCreator: SessionCreatorBridge
  }
}
