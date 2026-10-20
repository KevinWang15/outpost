import { Bell, CircleAlert, CircleHelp, LoaderCircle } from 'lucide-react'
import { activityLabel } from '../../shared/activity'
import type { Session } from '../../shared/model'

/** Native agent state and observation freshness, shared with desktop badges. */
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
  const label = activityLabel(activity)
  const stale = activity.observation === 'stale'
  if (session.status === 'ready') return <span className="muted">—</span>
  if (state === 'unknown')
    return (
      <span className="badge unavailable" title={activity.detail ?? undefined}>
        <CircleHelp size={12} />
        {label}
      </span>
    )
  if (state === 'finished') {
    return (
      <button
        className="badge finished"
        disabled={checking || stale}
        onClick={() => onCheck(session)}
        title={
          stale
            ? (activity.detail ?? undefined)
            : 'The agent finished and is waiting for you. Click to mark as checked.'
        }
        aria-label={`Mark ${session.name} as checked`}
      >
        {checking ? <LoaderCircle className="spin" size={12} /> : <Bell size={12} />}
        {label}
      </button>
    )
  }
  if (state === 'working')
    return (
      <span className="badge working" title={activity.detail ?? undefined}>
        <LoaderCircle className={stale ? undefined : 'spin'} size={12} />
        {label}
      </span>
    )
  if (state === 'waiting' || state === 'error')
    return (
      <span className={`badge ${state}`} title={activity.detail ?? undefined}>
        {state === 'waiting' ? <Bell size={12} /> : <CircleAlert size={12} />}
        {label}
      </span>
    )
  return (
    <span className="badge idle" title={activity.detail ?? undefined}>
      <i />
      {label}
    </span>
  )
}
