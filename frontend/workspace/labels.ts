import type { SoftwareId, Target } from '../../shared/model'
import { harnesses } from '../../shared/harnesses'

const systemLabels: Record<string, string> = {
  bash: 'Bash',
  python3: 'Python 3',
  'outpost-terminal': 'Outpost Terminal',
}
export const softwareLabel = (id: SoftwareId) => harnesses.find(harness => harness.id === id)?.label ?? systemLabels[id]
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
    ? `root@${target.host}${target.port ? `:${target.port}` : ''}`
    : target.environment?.username
      ? `${target.environment.username} on this computer`
      : 'This computer'
