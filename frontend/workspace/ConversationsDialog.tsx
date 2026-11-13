import { useState } from 'react'
import { ArrowRightLeft, MessageSquareText } from 'lucide-react'
import type { Session } from '../../shared/model'
import { harnessLabel } from '../../shared/harnesses'
import { Dialog } from '../ui/Dialog'
import { relativeTime } from './labels'

/** A session's conversations, newest first; choosing an earlier one resumes it at the next start. */
export default function ConversationsDialog({
  session,
  restarts = false,
  onSwitch,
  onClose,
}: {
  session: Session
  /** `onSwitch` stops a running session and starts it again in the chosen conversation. */
  restarts?: boolean
  onSwitch: (conversation: string) => Promise<unknown>
  onClose: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const blocked = session.driver !== null && !restarts
  const current = session.conversations.at(-1)!
  const conversations = [...session.conversations].reverse()

  async function choose(conversation: string) {
    setBusy(conversation)
    setError('')
    try {
      await onSwitch(conversation)
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
        <button className="button" type="button" disabled={busy !== null} onClick={onClose}>
          Close
        </button>
      }
    >
      {current.movedTo && (
        <p className="warning" role="status">
          The current conversation continues in {current.movedTo.name} now. Choose another one to resume here.
        </p>
      )}
      {blocked && <p className="hint">Terminate the session to resume another conversation.</p>}
      {restarts && session.driver !== null && (
        <p className="hint">Resuming another conversation restarts the coding tool in it.</p>
      )}
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
              {!isCurrent && !conversation.movedTo && (
                <button
                  className="button small"
                  aria-label={`Resume ${label}`}
                  disabled={blocked || busy !== null}
                  onClick={() => void choose(conversation.id)}
                >
                  <ArrowRightLeft size={14} />
                  {busy === conversation.id ? 'Switching…' : 'Resume'}
                </button>
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
