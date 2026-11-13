import type { Session, Target } from '../../shared/model'
import { pagePaths } from '../../shared/pages'

export const shortVersion = (version: string | null) => version?.match(/\d+(?:\.\d+)+[a-z]?/)?.[0] ?? version ?? ''

export function relativeTime(value: string | null) {
  if (!value) return '—'
  const minutes = Math.floor((Date.now() - new Date(value).getTime()) / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`
  return new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export const address = (target: Target) =>
  target.kind === 'ssh'
    ? `${target.user}@${target.host}${target.port ? `:${target.port}` : ''}`
    : target.environment?.username
      ? `${target.environment.username} on this computer`
      : 'This computer'

/** Where a session runs now, in the words both modes use. */
export function placeLabel(session: Pick<Session, 'driver' | 'status'>) {
  if (session.driver === 'chat') return 'In chat'
  if (session.driver === 'terminal')
    return session.status === 'attached' ? 'In a terminal · connected' : 'In a terminal'
  return session.status === 'ready' ? 'Not started' : 'Not running'
}

/** A session in chat; `start` starts its coding tool there, `schedule` opens a new schedule for it. */
export function chatHref(targetId: string, sessionId: string, extra: { start?: boolean; schedule?: boolean } = {}) {
  const query = new URLSearchParams({ target: targetId, session: sessionId })
  if (extra.start) query.set('start', '1')
  if (extra.schedule) query.set('schedule', 'new')
  return `${pagePaths.chat}?${query}`
}
