import { useEffect, useMemo, useRef, useState } from 'react'
import { MessagesSquare, Plus } from 'lucide-react'
import { sessionKey } from '../../shared/chatApi'
import ChannelView from './ChannelView'
import { ChatClient } from './client'
import { ChatClientContext, ShellContext, useChat, type ChatDialog, type Selection } from './context'
import {
  ChannelDialog,
  ContinueChatDialog,
  ConversationsChatDialog,
  DeleteChatDialog,
  FindChatDialog,
  ForkChatDialog,
  MachineLink,
  NewSessionDialog,
  ScheduleDialog,
  SessionSettingsChatDialog,
  StopChatDialog,
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

/** Machines links here with ?start=1 to start the session in chat, or
 * ?schedule=new to schedule a task for it. Both apply once. */
function intentFromUrl() {
  const query = new URLSearchParams(window.location.search)
  return { start: query.get('start') === '1', schedule: query.get('schedule') === 'new' }
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
          Select a session under its machine to message it. Use a channel to mention sessions from several machines.
        </p>
        {client.targets.length > 0 && !client.sessions.length && (
          <button className="button primary" onClick={() => open({ kind: 'session' })}>
            <Plus size={15} /> New session
          </button>
        )}
        {client.sessionsLoaded && !client.targets.length && (
          <p className="muted">
            Chat uses server-connected machines. <MachineLink>Add a machine</MachineLink>.
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
  const intent = useRef(intentFromUrl())
  const loaded = client.sessionsLoaded
  useEffect(() => {
    const wanted = intent.current
    if (selection?.kind !== 'session' || !loaded || (!wanted.start && !wanted.schedule)) return
    intent.current = { start: false, schedule: false }
    if (wanted.start) client.restart(selection)
    if (wanted.schedule) setDialog({ kind: 'schedule', scheduleId: null, session: selection })
    window.history.replaceState(null, '', selectionUrl(selection))
  }, [client, selection, loaded])
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
        {dialog?.kind === 'session' && (
          <NewSessionDialog machine={dialog.targetId} conversation={dialog.conversation} onClose={close} />
        )}
        {dialog?.kind === 'find' && <FindChatDialog query={dialog.query} onClose={close} />}
        {dialog?.kind === 'fork' && <ForkChatDialog target={dialog} onClose={close} />}
        {dialog?.kind === 'stop' && <StopChatDialog target={dialog} onClose={close} />}
        {dialog?.kind === 'delete' && <DeleteChatDialog target={dialog} onClose={close} />}
        {dialog?.kind === 'chat' && <ContinueChatDialog target={dialog} onClose={close} />}
        {dialog?.kind === 'channel' && (
          <ChannelDialog membersOnly={dialog.membersOnly} channelId={dialog.channelId} onClose={close} />
        )}
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

export default function ChatApp() {
  const client = useMemo(() => new ChatClient(), [])
  useEffect(() => {
    void client.connect()
    const wake = () => document.visibilityState === 'visible' && client.wake()
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)
    window.addEventListener('focus', wake)
    return () => {
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake)
      window.removeEventListener('focus', wake)
      client.dispose()
    }
  }, [client])
  return (
    <ChatClientContext.Provider value={client}>
      <Shell />
    </ChatClientContext.Provider>
  )
}
