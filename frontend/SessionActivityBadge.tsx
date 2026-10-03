import { Bell, Circle, CircleHelp, LoaderCircle } from 'lucide-react'
import type { Session } from '../shared/session-manager'

export default function SessionActivityBadge({ session, checking, onCheck }: {
  session: Session
  checking: boolean
  onCheck: (session: Session) => void
}) {
  const { activity } = session
  if (activity.detail) return <span className="activity-badge unavailable" title={activity.detail}>
    <CircleHelp size={13} aria-hidden="true" /> Activity unavailable
  </span>
  if (activity.state === 'finished') return <button
    className="activity-badge finished"
    aria-label={`Mark ${session.name} as checked`}
    title="AI finished and is waiting for you. Click to mark this turn as checked."
    disabled={checking}
    onClick={() => onCheck(session)}
  >
    {checking ? <LoaderCircle className="loading-spinner" size={13} aria-hidden="true" /> : <Bell size={13} aria-hidden="true" />}
    {checking ? 'Checking…' : 'Awaiting you'}
  </button>
  return <span className={`activity-badge ${activity.state}`}>
    {activity.state === 'working'
      ? <LoaderCircle className="loading-spinner" size={13} aria-hidden="true" />
      : <Circle size={6} fill="currentColor" strokeWidth={0} aria-hidden="true" />}
    {activity.state === 'working' ? 'AI working' : 'Idle'}
  </span>
}
