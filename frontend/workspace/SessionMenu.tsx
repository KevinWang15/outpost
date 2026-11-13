import {
  CalendarClock,
  GitFork,
  History,
  MessageSquarePlus,
  MessagesSquare,
  Pencil,
  Square,
  SquareTerminal,
  Trash2,
} from 'lucide-react'
import { useState } from 'react'
import type { Session } from '../../shared/model'
import { harnessLabel, supportsTerminal } from '../../shared/harnesses'
import { Confirm, Dialog } from '../ui/Dialog'
import { Menu, type MenuItem } from '../ui/Menu'

/** What a session's menu can do. Both modes show the same actions in the same
 * order; `chat` and `terminal` are left out where that is the primary action
 * or the current view. */
export interface SessionActions {
  chat?: () => void
  terminal?: () => void
  /** Chat only: a fresh conversation in the running chat. */
  newConversation?: { onSelect: () => void; disabled: boolean }
  conversations: () => void
  edit: () => void
  fork: () => void
  schedule: () => void
  stop: () => void
  remove: () => void
}

export function SessionMenu({ session, label, actions }: { session: Session; label: string; actions: SessionActions }) {
  const items: (MenuItem | 'separator')[] = []
  if (actions.terminal)
    items.push({
      label: session.driver === 'chat' ? 'Continue in a terminal' : 'Open in a terminal',
      icon: <SquareTerminal size={14} />,
      disabled: !supportsTerminal(session.tool),
      onSelect: actions.terminal,
    })
  if (actions.chat)
    items.push({
      label: session.driver === 'terminal' ? 'Continue in chat' : 'Open in chat',
      icon: <MessagesSquare size={14} />,
      onSelect: actions.chat,
    })
  if (actions.newConversation)
    items.push({ label: 'New conversation', icon: <MessageSquarePlus size={14} />, ...actions.newConversation })
  items.push(
    { label: 'Conversations', icon: <History size={14} />, onSelect: actions.conversations },
    { label: 'Edit session', icon: <Pencil size={14} />, onSelect: actions.edit },
    { label: 'Fork', icon: <GitFork size={14} />, onSelect: actions.fork },
    { label: 'Schedule a task', icon: <CalendarClock size={14} />, onSelect: actions.schedule },
    'separator',
    session.driver
      ? { label: 'Stop coding tool', icon: <Square size={14} />, danger: true, onSelect: actions.stop }
      : { label: 'Delete session', icon: <Trash2 size={14} />, danger: true, onSelect: actions.remove },
  )
  return <Menu label={label} items={items} />
}

const working = (session: Session) => ['working', 'waiting'].includes(session.activity.state)

export function StopConfirm({
  session,
  onConfirm,
  onClose,
}: {
  session: Session
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  return (
    <Confirm
      title={`Stop ${session.name}?`}
      action="Stop coding tool"
      description={`This ends ${harnessLabel(session.tool)} and its processes${session.driver === 'terminal' ? ' and disconnects open terminals' : ''}.${working(session) ? ' It is working now; stopping interrupts the current turn.' : ''} The conversation is kept, and the session resumes it when it starts again.`}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  )
}

export function DeleteConfirm({
  session,
  onConfirm,
  onClose,
}: {
  session: Session
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  return (
    <Confirm
      title={`Delete ${session.name}?`}
      action="Delete session"
      description="This removes the session from Outpost. The project directory and the coding tool’s history are kept."
      onConfirm={onConfirm}
      onClose={onClose}
    />
  )
}

/** Continue a session that runs in a terminal in chat: the terminal's process ends
 * so chat can continue the same conversation. */
export function ContinueInChat({
  session,
  onConfirm,
  onClose,
}: {
  session: Session
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  return (
    <Confirm
      title={`Continue ${session.name} in chat?`}
      action="Continue in chat"
      description={`This ends the terminal’s ${harnessLabel(session.tool)} process and disconnects open terminals.${working(session) ? ' It is working now; this interrupts the current turn.' : ''} The conversation stays and continues in chat.`}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  )
}

/** Open a session in a terminal. One that runs in chat stops there first; the
 * terminal then opens from a second click, so a remembered web terminal can open
 * its pop-up within that click. */
export function MoveToTerminal({
  session,
  stop,
  onOpen,
  onClose,
}: {
  session: Session
  stop: () => Promise<void>
  onOpen: () => void | Promise<void>
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(session.driver !== 'chat')
  if (!supportsTerminal(session.tool))
    return (
      <Dialog
        title={harnessLabel(session.tool)}
        description={`${harnessLabel(session.tool)} runs in Outpost Chat and has no terminal interface.`}
        size="small"
        onClose={onClose}
        footer={
          <button className="button" onClick={onClose}>
            Close
          </button>
        }
      >
        {null}
      </Dialog>
    )
  return (
    <Dialog
      title={ready ? `Open ${session.name} in a terminal` : `Continue ${session.name} in a terminal?`}
      description={
        ready
          ? 'The same conversation continues in the coding tool’s own terminal interface.'
          : `This ends the chat’s ${harnessLabel(session.tool)} process. The conversation stays and continues in the terminal.`
      }
      size="small"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button className="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          {ready ? (
            <button
              className="button primary"
              disabled={busy}
              onClick={() => {
                const opening = onOpen()
                if (!opening) return
                setBusy(true)
                opening.catch(problem => {
                  setError((problem as Error).message)
                  setBusy(false)
                })
              }}
            >
              Open terminal
            </button>
          ) : (
            <button
              className={`button ${working(session) ? 'danger' : 'primary'}`}
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setError('')
                try {
                  await stop()
                  setReady(true)
                } catch (problem) {
                  setError((problem as Error).message)
                }
                setBusy(false)
              }}
            >
              {working(session) ? 'Stop the current work and continue' : 'Continue in a terminal'}
            </button>
          )}
        </>
      }
    >
      {working(session) && !ready && (
        <p className="warning">{session.name} is working now. Stopping it interrupts the current turn.</p>
      )}
      {error && <p className="error">{error}</p>}
    </Dialog>
  )
}
