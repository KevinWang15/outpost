import { createContext, useContext, useSyncExternalStore } from 'react'
import type { SessionRef } from '../../shared/chatApi'
import type { ChatBridge } from '../../shared/chatBridge'
import type { ChatClient } from './client'

export type Selection = ({ kind: 'session' } & SessionRef) | { kind: 'channel'; channelId: string } | null

export type ChatDialog =
  | { kind: 'session' }
  | { kind: 'channel'; channelId: string | null }
  | { kind: 'schedule'; scheduleId: string | null; session: SessionRef | null }
  | ({ kind: 'instructions' } & SessionRef)
  | ({ kind: 'terminal' } & SessionRef)

export interface ChatApp {
  client: ChatClient
  bridge: ChatBridge | null
  openLink(url: string): void
}
export interface ChatShell {
  select(selection: Selection): void
  open(dialog: ChatDialog): void
}

export const ChatAppContext = createContext<ChatApp | null>(null)
export const ShellContext = createContext<ChatShell>({ select() {}, open() {} })

/** The app, its navigation, and a re-render on every store change. */
export function useChat() {
  const app = useContext(ChatAppContext)!
  const shell = useContext(ShellContext)
  useSyncExternalStore(app.client.subscribe, app.client.getVersion)
  return { ...app, ...shell }
}

export interface ConversationActions {
  answer(request: string, optionId: string | null): Promise<void>
  unqueue(turn: string): Promise<void>
  previews(key: string | null): string[]
  /** Read-only views (a channel's member steps) offer no controls. */
  readOnly: boolean
}
export const ConversationContext = createContext<ConversationActions>({
  answer: async () => {},
  unqueue: async () => {},
  previews: () => [],
  readOnly: true,
})

export interface MarkdownOptions {
  /** Handles to highlight as @mentions. */
  handles: readonly string[]
  openLink: (url: string) => void
}
export const MarkdownContext = createContext<MarkdownOptions>({
  handles: [],
  openLink: url => void window.open(url, '_blank', 'noopener'),
})
