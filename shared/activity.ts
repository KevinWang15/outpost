import { blockedKinds, type BlockedKind } from './programStatus'

/** Native turn state shared by session lists, terminal streams and desktop tabs. */
export const activityStates = ['working', 'waiting', 'idle', 'finished', 'error', 'unknown'] as const
export type ActivityState = (typeof activityStates)[number]

export interface SessionActivity {
  state: ActivityState
  /** What a `waiting` session needs from the user (OSC 7501 `kind`). */
  blockedKind: BlockedKind | null
  /** Indeterminate when null; 0..100 when `working` or `waiting` (OSC 7501 `progress`). */
  progress: number | null
  updatedAt: string | null
  completionId: string | null
  detail: string | null
  /** `unavailable`: no valid reading (then the state is `unknown`). */
  observation: 'current' | 'unavailable'
  observedAt: string | null
}

const activityLabels = {
  working: 'Working',
  waiting: 'Waiting for you',
  idle: 'Idle',
  finished: 'Needs you',
  unknown: 'Unknown',
  error: 'Error',
} satisfies Record<ActivityState, string>

const blockedLabels: Record<BlockedKind, string> = {
  permission: 'Needs approval',
  question: 'Waiting for answer',
  auth: 'Needs sign-in',
}

export function unavailableActivity(detail: string): SessionActivity {
  return {
    state: 'unknown',
    blockedKind: null,
    progress: null,
    updatedAt: null,
    completionId: null,
    detail: detail.slice(0, 4096),
    observation: 'unavailable',
    observedAt: null,
  }
}

export function activityLabel(activity: SessionActivity) {
  if (activity.state === 'waiting' && activity.blockedKind) return blockedLabels[activity.blockedKind]
  if (activity.state === 'working' && activity.progress !== null) return `Working · ${activity.progress}%`
  return activityLabels[activity.state]
}

/** Bound and copy data at the connection and native IPC boundaries. */
export function parseSessionActivity(value: unknown): SessionActivity | null {
  if (!value || typeof value !== 'object') return null
  const item = value as SessionActivity
  const nullableText = (text: unknown, limit: number) =>
    text === null || (typeof text === 'string' && text.length <= limit)
  const validBlockedKind =
    item.blockedKind === null ||
    (item.state === 'waiting' && typeof item.blockedKind === 'string' && blockedKinds.includes(item.blockedKind))
  const validProgress =
    item.progress === null ||
    ((item.state === 'working' || item.state === 'waiting') &&
      typeof item.progress === 'number' &&
      Number.isInteger(item.progress) &&
      item.progress >= 0 &&
      item.progress <= 100)
  if (
    !activityStates.includes(item.state) ||
    !validBlockedKind ||
    !validProgress ||
    !['current', 'unavailable'].includes(item.observation) ||
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
    blockedKind: item.blockedKind,
    progress: item.progress,
    updatedAt: item.updatedAt,
    completionId: item.completionId,
    detail: item.detail?.slice(0, 4096) ?? null,
    observation: item.observation,
    observedAt: item.observedAt,
  }
}
