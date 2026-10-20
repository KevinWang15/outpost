/** Native turn state shared by session lists, terminal streams and desktop tabs. */
export const activityStates = ['working', 'waiting', 'idle', 'finished', 'error', 'unknown'] as const
export type ActivityState = (typeof activityStates)[number]

export interface SessionActivity {
  state: ActivityState
  updatedAt: string | null
  completionId: string | null
  detail: string | null
  observation: 'current' | 'stale' | 'unavailable'
  observedAt: string | null
}

export const activityLabels = {
  working: 'Working',
  waiting: 'Waiting for you',
  idle: 'Idle',
  finished: 'Needs you',
  unknown: 'Unknown',
  error: 'Error',
} satisfies Record<ActivityState, string>

export function unavailableActivity(detail: string): SessionActivity {
  return {
    state: 'unknown',
    updatedAt: null,
    completionId: null,
    detail: detail.slice(0, 4096),
    observation: 'unavailable',
    observedAt: null,
  }
}

/** Unread completion is dismissible; a current approval or error is not. */
export function activityNeedsAttention(activity: SessionActivity | null) {
  return activity !== null && ['waiting', 'finished', 'error'].includes(activity.state)
}

export function activityLabel(activity: SessionActivity) {
  const label = activityLabels[activity.state]
  return activity.observation === 'stale' ? `${label} (last known)` : label
}

/** Bound and copy data at the relay and native IPC boundaries. */
export function parseSessionActivity(value: unknown): SessionActivity | null {
  if (!value || typeof value !== 'object') return null
  const item = value as SessionActivity
  const nullableText = (text: unknown, limit: number) =>
    text === null || (typeof text === 'string' && text.length <= limit)
  if (
    !activityStates.includes(item.state) ||
    !['current', 'stale', 'unavailable'].includes(item.observation) ||
    !nullableText(item.observedAt, 64) ||
    !nullableText(item.updatedAt, 64) ||
    !(
      item.completionId === null ||
      (typeof item.completionId === 'string' && /^[a-f0-9]{64}$/.test(item.completionId))
    ) ||
    (item.state === 'finished') !== (item.completionId !== null) ||
    (item.observation === 'unavailable' && (item.state !== 'unknown' || item.observedAt !== null)) ||
    !(item.detail === null || typeof item.detail === 'string')
  )
    return null
  return {
    state: item.state,
    updatedAt: item.updatedAt,
    completionId: item.completionId,
    detail: item.detail?.slice(0, 4096) ?? null,
    observation: item.observation,
    observedAt: item.observedAt,
  }
}
