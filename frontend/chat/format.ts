import type { ActivityState } from '../../shared/activity'
import type { ChatSession } from '../../shared/chatApi'
import type { HarnessId } from '../../shared/harnesses'

export const harnessColor: Record<HarnessId, string> = {
  claude: '#c2410c',
  codex: '#1f2937',
  kimi: '#6d28d9',
}

export function clock(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function day(value: string) {
  const date = new Date(value)
  const today = new Date()
  const yesterday = new Date(today.getTime() - 86_400_000)
  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
}

export function elapsed(from: string | null, to: string | null = null) {
  if (!from) return ''
  const seconds = Math.max(
    0,
    Math.round(((to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime()) / 1000),
  )
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

export type Presence = ActivityState | 'stopped' | 'terminal'

/** One status for dots and labels: what the session is doing, or where it runs. */
export function presence(session: ChatSession): Presence {
  if (session.driver === 'terminal') return 'terminal'
  if (session.driver === null) return session.activity.state === 'error' ? 'error' : 'stopped'
  return session.activity.state
}

export const presenceLabel: Record<Presence, string> = {
  working: 'Working',
  waiting: 'Waiting for you',
  idle: 'Idle',
  finished: 'Replied',
  error: 'Error',
  unknown: 'Unknown',
  stopped: 'Not running',
  terminal: 'In a terminal',
}

export const needsYou = (session: ChatSession) => ['waiting', 'finished', 'error'].includes(presence(session))
