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
import type { Session } from '../../shared/model'
import { harnessLabel } from '../../shared/harnesses'
import { Confirm } from '../ui/Dialog'
import { Menu, type MenuItem } from '../ui/Menu'

/** Machines and Chat share the session menu. Each page supplies the actions available there. */
export interface SessionActions {
  chat?: () => void
  terminal?: () => void
  /** Chat only: a fresh conversation in the running chat. */
  newConversation?: { onSelect: () => void; disabled: boolean }
  conversations: () => void
  edit: () => void
  fork: () => void
  schedule?: () => void
  stop: () => void
  remove: () => void
}

export function SessionMenu({ session, label, actions }: { session: Session; label: string; actions: SessionActions }) {
  const items: (MenuItem | 'separator')[] = []
  if (actions.terminal)
    items.push({
      label: 'Open in Terminal',
      icon: <SquareTerminal size={14} />,
      onSelect: actions.terminal,
    })
  if (actions.chat)
    items.push({
      label: 'Open in Chat',
      icon: <MessagesSquare size={14} />,
      onSelect: actions.chat,
    })
  if (actions.newConversation)
    items.push({ label: 'New conversation', icon: <MessageSquarePlus size={14} />, ...actions.newConversation })
  items.push(
    { label: 'Conversations', icon: <History size={14} />, onSelect: actions.conversations },
    { label: 'Edit session', icon: <Pencil size={14} />, onSelect: actions.edit },
    { label: 'Fork', icon: <GitFork size={14} />, onSelect: actions.fork },
    ...(actions.schedule
      ? [{ label: 'Schedule a task', icon: <CalendarClock size={14} />, onSelect: actions.schedule }]
      : []),
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
      description={`This ends ${harnessLabel(session.tool)} and its processes and disconnects any open terminals.${working(session) ? ' It is working now; stopping interrupts the current turn.' : ''} The conversation is kept, and the session resumes it when it starts again.`}
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
