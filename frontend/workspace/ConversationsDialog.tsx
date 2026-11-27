import { useState } from 'react'
import { ArrowRightLeft, MessageSquareText, Plus } from 'lucide-react'
import type { Session } from '../../shared/model'
import { harnessLabel } from '../../shared/harnesses'
import { Dialog } from '../ui/Dialog'
import { ToolIcon } from '../ui/ToolIcon'
import { relativeTime } from './labels'

/** A session's remembered conversations, newest first; choosing an earlier one resumes it at the next start. */
export default function ConversationsDialog({
  session,
  whileRunning,
  onSwitch,
  onNewConversation,
  onClose,
}: {
  session: Session
  /** What resuming does to the running coding tool; `onSwitch` stops it first. */
  whileRunning: string
  onSwitch: (conversation: string, options?: { reclaim?: boolean }) => Promise<unknown>
  onNewConversation?: () => Promise<unknown>
  onClose: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const current = session.conversation
    ? (session.conversations.find(item => item.id === session.conversation && item.tool === session.tool) ?? null)
    : null
  const conversations = [...session.conversations].reverse()
  const multiTool = new Set(session.conversations.map(item => item.tool)).size > 1

  async function choose(conversation: string, reclaim = false) {
    setBusy(conversation)
    setError('')
    try {
      await onSwitch(conversation, reclaim ? { reclaim: true } : undefined)
      onClose()
    } catch (problem) {
      setError((problem as Error).message)
      setBusy(null)
    }
  }

  async function startNew() {
    if (!onNewConversation) return
    setBusy('__new__')
    setError('')
    try {
      await onNewConversation()
      onClose()
    } catch (problem) {
      setError((problem as Error).message)
      setBusy(null)
    }
  }

  return (
    <Dialog
      title={`Conversations in ${session.name}`}
      description={`Conversations remembered across runs in ${harnessLabel(session.tool)}. Resuming one makes it current the next time the session starts.`}
      busy={busy !== null}
      onClose={onClose}
      footer={
        <>
          {onNewConversation && (
            <button
              className={current?.movedTo ? 'button primary' : 'button'}
              type="button"
              disabled={busy !== null}
              onClick={() => void startNew()}
            >
              <Plus size={14} />
              {busy === '__new__' ? 'Starting…' : 'New conversation'}
            </button>
          )}
          <button className="button" type="button" disabled={busy !== null} onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {current?.movedTo && (
        <p className="warning" role="status">
          The current conversation continues in {current.movedTo.name} now. Resume another conversation, move it back
          here, or start a new one.
        </p>
      )}
      {!session.conversation && (
        <p className="hint">No active conversation ID is pinned — the next start will begin a fresh conversation.</p>
      )}
      {session.driver !== null && <p className="hint">{whileRunning}</p>}
      {conversations.length > 0 ? (
        <ul className="choices conversations" aria-label="Conversations">
          {conversations.map(conversation => {
            const isCurrent = current !== null && conversation.id === current.id && conversation.tool === current.tool
            const label = conversation.id
            return (
              <li key={`${conversation.tool}:${conversation.id}`} className="choice">
                <span className="choice-icon">
                  <MessageSquareText size={17} />
                </span>
                <span className="choice-text">
                  <span className="choice-title">
                    <code>{label}</code>
                    {(multiTool || conversation.tool !== session.tool) && (
                      <span className="chip">
                        <ToolIcon tool={conversation.tool} size={11} />
                        {harnessLabel(conversation.tool)}
                      </span>
                    )}
                    {isCurrent && !conversation.movedTo && <span className="chip">Current</span>}
                  </span>
                  <span className="choice-detail">
                    {conversation.movedTo
                      ? `Moved to ${conversation.movedTo.name}`
                      : `Started ${relativeTime(conversation.startedAt).replace('Just now', 'just now')}`}
                  </span>
                </span>
                {conversation.movedTo ? (
                  <button
                    className="button small"
                    aria-label={`Move ${label} back here`}
                    disabled={busy !== null}
                    onClick={() => void choose(conversation.id, true)}
                  >
                    <ArrowRightLeft size={14} />
                    {busy === conversation.id ? 'Moving…' : 'Move back'}
                  </button>
                ) : (
                  !isCurrent && (
                    <button
                      className="button small"
                      aria-label={`Resume ${label}`}
                      disabled={busy !== null}
                      onClick={() => void choose(conversation.id)}
                    >
                      <ArrowRightLeft size={14} />
                      {busy === conversation.id ? 'Switching…' : 'Resume'}
                    </button>
                  )
                )}
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="muted">No remembered conversations yet.</p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  )
}
