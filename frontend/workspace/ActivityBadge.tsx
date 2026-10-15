import { Bell, CircleHelp, LoaderCircle } from 'lucide-react'
import { activityLabels } from '../../shared/activity'
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
  const { state } = activity
  if (session.status === 'ready') return <span className="muted">—</span>
  if (state === 'unknown')
    return (
      <span className="badge unavailable" title={activity.detail ?? undefined}>
        <CircleHelp size={12} />
        {activityLabels[state]}
      </span>
    )
  if (state === 'finished') {
    return (
      <button
        className="badge finished"
        disabled={checking}
        onClick={() => onCheck(session)}
        title="The agent finished and is waiting for you. Click to mark as checked."
        aria-label={`Mark ${session.name} as checked`}
      >
        {checking ? <LoaderCircle className="spin" size={12} /> : <Bell size={12} />}
        {activityLabels[state]}
      </button>
    )
  }
  if (state === 'working')
    return (
      <span className="badge working">
        <LoaderCircle className="spin" size={12} />
        {activityLabels[state]}
      </span>
    )
  return (
    <span className="badge idle">
      <i />
      {activityLabels[state]}
    </span>
  )
}
