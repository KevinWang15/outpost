// Account-scoped in-memory stale-while-revalidate cache so switching between
// Machines, Logs, Chat, and User Guide paints known data immediately while revalidating.
import type { LogView, Webhook } from '../../shared/logs'
import type { Session, SoftwareReport, Target } from '../../shared/model'

export interface LogsCacheEntry {
  view: LogView
  webhooks: Webhook[]
}

interface AccountCache {
  targets: Target[] | null
  sessions: Map<string, Session[]>
  software: Map<string, SoftwareReport>
  logs: LogsCacheEntry | null
}

let activeAccount: string | null = null
let cache: AccountCache = emptyCache()

function emptyCache(): AccountCache {
  return {
    targets: null,
    sessions: new Map(),
    software: new Map(),
    logs: null,
  }
}

function cacheFor(accountKey: string): AccountCache {
  if (activeAccount !== accountKey) {
    activeAccount = accountKey
    cache = emptyCache()
  }
  return cache
}

export function clearWorkspaceCache() {
  activeAccount = null
  cache = emptyCache()
}

export function getCachedTargets(accountKey: string): Target[] | null {
  return cacheFor(accountKey).targets
}

export function setCachedTargets(accountKey: string, targets: Target[]) {
  cacheFor(accountKey).targets = targets
}

export function getCachedSessions(accountKey: string, targetId: string): Session[] | null {
  return cacheFor(accountKey).sessions.get(targetId) ?? null
}

export function setCachedSessions(accountKey: string, targetId: string, sessions: Session[]) {
  cacheFor(accountKey).sessions.set(targetId, sessions)
}

export function deleteCachedSessions(accountKey: string, targetId: string) {
  cacheFor(accountKey).sessions.delete(targetId)
}

export function getCachedSoftware(accountKey: string, targetId: string): SoftwareReport | null {
  return cacheFor(accountKey).software.get(targetId) ?? null
}

export function setCachedSoftware(accountKey: string, targetId: string, report: SoftwareReport) {
  cacheFor(accountKey).software.set(targetId, report)
}

export function getCachedLogs(accountKey: string): LogsCacheEntry | null {
  return cacheFor(accountKey).logs
}

export function setCachedLogs(accountKey: string, entry: LogsCacheEntry) {
  cacheFor(accountKey).logs = entry
}
