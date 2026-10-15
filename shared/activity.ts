/** Native turn state shared by session lists, terminal streams and desktop tabs. */
export const activityStates = ['working', 'idle', 'finished'] as const
export type ActivityState = (typeof activityStates)[number]

export interface SessionActivity {
  state: ActivityState
  updatedAt: string | null
  completionId: string | null
  detail: string | null
}

export const activityLabels = {
  working: 'Working',
  idle: 'Idle',
  finished: 'Needs you',
  unknown: 'Unknown',
} satisfies Record<ActivityState | 'unknown', string>

/** A failed observation is unknown, even though its wire state defaults to idle. */
export function activityState(activity: SessionActivity | null): ActivityState | 'unknown' {
  return !activity || activity.detail ? 'unknown' : activity.state
}

/** Bound and copy data at the relay and native IPC boundaries. */
export function parseSessionActivity(value: unknown): SessionActivity | null {
  if (!value || typeof value !== 'object') return null
  const item = value as SessionActivity
  const nullableText = (text: unknown, limit: number) =>
    text === null || (typeof text === 'string' && text.length <= limit)
  if (
    !activityStates.includes(item.state) ||
    !nullableText(item.updatedAt, 64) ||
    !(
      item.completionId === null ||
      (typeof item.completionId === 'string' && /^[a-f0-9]{64}$/.test(item.completionId))
    ) ||
    !nullableText(item.detail, 4096)
  )
    return null
  return { state: item.state, updatedAt: item.updatedAt, completionId: item.completionId, detail: item.detail }
}
