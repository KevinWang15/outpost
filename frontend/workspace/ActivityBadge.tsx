import { Bell, CircleHelp, LoaderCircle } from 'lucide-react'
import type { Session } from '../../shared/model'

/** What the coding tool is doing: working, idle, or finished a turn you have not checked. */
export default function ActivityBadge({
  session,
  checking,
  onCheck,
}: {
  session: Session
  checking: boolean
  onCheck: (session: Session) => void
}) {
  const { activity } = session
  if (session.status === 'ready') return <span className="muted">—</span>
  if (activity.detail)
    return (
      <span className="badge unavailable" title={activity.detail}>
        <CircleHelp size={12} />
        Unknown
      </span>
    )
  if (activity.state === 'finished') {
    return (
      <button
        className="badge finished"
        disabled={checking}
        onClick={() => onCheck(session)}
        title="The agent finished and is waiting for you. Click to mark as checked."
        aria-label={`Mark ${session.name} as checked`}
      >
        {checking ? <LoaderCircle className="spin" size={12} /> : <Bell size={12} />}Needs you
      </button>
    )
  }
  if (activity.state === 'working')
    return (
      <span className="badge working">
        <LoaderCircle className="spin" size={12} />
        Working
      </span>
    )
  return (
    <span className="badge idle">
      <i />
      Idle
    </span>
  )
}
