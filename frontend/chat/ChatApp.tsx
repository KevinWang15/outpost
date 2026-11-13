import { useCallback, useEffect, useMemo, useState } from 'react'
import { MessagesSquare, Plus } from 'lucide-react'
import { sessionKey } from '../../shared/chatApi'
import type { ChatBridge } from '../../shared/chatBridge'
import { pagePaths } from '../../shared/pages'
import ChannelView from './ChannelView'
import { ChatClient } from './client'
import {
  ChatAppContext,
  MarkdownContext,
  ShellContext,
  useChat,
  type ChatApp as App,
  type ChatDialog,
  type Selection,
} from './context'
import {
  ChannelDialog,
  ConversationsChatDialog,
  NewSessionDialog,
  ScheduleDialog,
  SessionSettingsChatDialog,
  TerminalDialog,
} from './Dialogs'
import { needsYou } from './format'
import SessionView from './SessionView'
import Sidebar from './Sidebar'
import '../styles/chat.scss'

function selectionFromUrl(): Selection {
  const query = new URLSearchParams(window.location.search)
  const channel = query.get('channel')
  if (channel) return { kind: 'channel', channelId: channel }
  const target = query.get('target'),
    session = query.get('session')
  return target && session ? { kind: 'session', targetId: target, sessionId: session } : null
}

function selectionUrl(selection: Selection) {
  const query = new URLSearchParams()
  if (selection?.kind === 'channel') query.set('channel', selection.channelId)
  else if (selection?.kind === 'session') {
    query.set('target', selection.targetId)
    query.set('session', selection.sessionId)
  }
  const search = query.toString()
  return `${window.location.pathname}${search ? `?${search}` : ''}`
}

function Welcome() {
  const { client, open } = useChat()
  return (
    <section className="conversation welcome-chat">
      <div className="transcript-empty">
        <span className="channel-icon large">
          <MessagesSquare size={26} />
        </span>
        <h2>Chat with your coding sessions</h2>
        <p>
          Every session is a coding agent on one of your machines. Message one directly, or bring several into a channel
          where they reply when you mention them. They keep working while you are away.
        </p>
        <button className="button primary" disabled={!client.targets.length} onClick={() => open({ kind: 'session' })}>
          <Plus size={15} /> New session
        </button>
        {client.sessionsLoaded && !client.targets.length && (
          <p className="muted">
            Add a machine in <a href={pagePaths.workspace}>Terminal</a> mode first.
          </p>
        )}
      </div>
    </section>
  )
}

function Shell() {
  const { client } = useChat()
  const [selection, setSelection] = useState<Selection>(selectionFromUrl)
  const [dialog, setDialog] = useState<ChatDialog | null>(null)
  useEffect(() => {
    const restore = () => setSelection(selectionFromUrl())
    window.addEventListener('popstate', restore)
    return () => window.removeEventListener('popstate', restore)
  }, [])
  // The tab title counts what needs attention.
  const attention =
    client.sessions.filter(needsYou).length +
    [...client.channels.values()].filter(
      channel => channel.lastAt && (!channel.readAt || channel.lastAt > channel.readAt),
    ).length
  useEffect(() => {
    document.title = attention ? `(${attention}) Outpost` : 'Outpost'
  }, [attention])
  const close = () => setDialog(null)
  return (
    <ShellContext.Provider
      value={{
        select: next => {
          setSelection(next)
          window.history.pushState(null, '', selectionUrl(next))
        },
        open: setDialog,
      }}
    >
      <div className={`chat-app ${selection ? 'has-selection' : ''}`}>
        <Sidebar selection={selection} />
        <main className="chat-main">
          {selection?.kind === 'session' ? (
            <SessionView
              key={sessionKey(selection)}
              target={selection}
              onBack={() => {
                setSelection(null)
                window.history.pushState(null, '', selectionUrl(null))
              }}
            />
          ) : selection?.kind === 'channel' ? (
            <ChannelView
              key={selection.channelId}
              channelId={selection.channelId}
              onBack={() => {
                setSelection(null)
                window.history.pushState(null, '', selectionUrl(null))
              }}
            />
          ) : (
            <Welcome />
          )}
        </main>
        {dialog?.kind === 'session' && <NewSessionDialog onClose={close} />}
        {dialog?.kind === 'channel' && <ChannelDialog channelId={dialog.channelId} onClose={close} />}
        {dialog?.kind === 'schedule' && (
          <ScheduleDialog scheduleId={dialog.scheduleId} session={dialog.session} onClose={close} />
        )}
        {dialog?.kind === 'settings' && <SessionSettingsChatDialog target={dialog} onClose={close} />}
        {dialog?.kind === 'conversations' && <ConversationsChatDialog target={dialog} onClose={close} />}
        {dialog?.kind === 'terminal' && <TerminalDialog target={dialog} onClose={close} />}
      </div>
    </ShellContext.Provider>
  )
}

/** The chat app: browser pages use their login; Outpost Desktop passes a bridge. */
export default function ChatApp({ bridge = null }: { bridge?: ChatBridge | null }) {
  const client = useMemo(() => new ChatClient(bridge ? async () => (await bridge.ticket()).ticket : null), [bridge])
  useEffect(() => {
    void client.connect()
    const wake = () => document.visibilityState === 'visible' && client.wake()
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)
    window.addEventListener('focus', wake)
    try {
      localStorage.setItem('outpost:mode', 'chat')
    } catch {
      /* Storage is optional. */
    }
    return () => {
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake)
      window.removeEventListener('focus', wake)
      client.dispose()
    }
  }, [client])
  const openLink = useCallback(
    (url: string) => (bridge ? bridge.openLink(url) : void window.open(url, '_blank', 'noopener,noreferrer')),
    [bridge],
  )
  const app = useMemo<App>(() => ({ client, bridge, openLink }), [client, bridge, openLink])
  return (
    <ChatAppContext.Provider value={app}>
      <MarkdownContext.Provider value={{ handles: [], openLink }}>
        <Shell />
      </MarkdownContext.Provider>
    </ChatAppContext.Provider>
  )
}
