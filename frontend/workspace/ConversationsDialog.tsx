import { useState } from 'react'
import { ArrowRightLeft, MessageSquareText, Plus } from 'lucide-react'
import type { Session } from '../../shared/model'
import { harnessLabel } from '../../shared/harnesses'
import { Dialog } from '../ui/Dialog'
import { relativeTime } from './labels'

/** A session's conversations, newest first; choosing an earlier one resumes it at the next start. */
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
  const current = session.conversations.at(-1)!
  const conversations = [...session.conversations].reverse()

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
      description={`New, clear and resume in ${harnessLabel(session.tool)} add conversations here. Resuming one makes it current the next time the session starts.`}
      busy={busy !== null}
      onClose={onClose}
      footer={
        <>
          {onNewConversation && (
            <button
              className={current.movedTo ? 'button primary' : 'button'}
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
      {current.movedTo && (
        <p className="warning" role="status">
          The current conversation continues in {current.movedTo.name} now. Resume another conversation, move it back
          here, or start a new one.
        </p>
      )}
      {session.driver !== null && <p className="hint">{whileRunning}</p>}
      <ul className="choices conversations" aria-label="Conversations">
        {conversations.map(conversation => {
          const isCurrent = conversation === current
          const label = conversation.title || 'Untitled conversation'
          return (
            <li key={conversation.id} className="choice">
              <span className="choice-icon">
                <MessageSquareText size={17} />
              </span>
              <span className="choice-text">
                <span className="choice-title">
                  {label}
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
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  )
}
