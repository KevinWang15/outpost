// The machine's sessions (~/.outpost/registry.json). Every writer holds the
// registry lock and replaces the file atomically; readers need no lock.
import { Value } from 'typebox/value'
import type { SessionRecord } from '../shared/model'
import { sessionRecord } from '../shared/schemas'
import { harness } from './harnesses'
import { locked, now, readJson, statePath, writeJson } from './state'

export interface Registry {
  version: 4
  sessions: SessionRecord[]
  /** Retryable creations by request key. Kept after deletion, so replaying an
   * old request can never resurrect a session deliberately removed. */
  creations: Record<string, { fingerprint: string; sessionId: string }>
}

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message)
  }
}

const path = () => statePath('registry.json')
const key = (session: SessionRecord, conversation: string) =>
  JSON.stringify([session.tool, Object.values(session.storage)[0], conversation])

function validate(data: unknown): Registry {
  const invalid = (detail: string) =>
    new RegistryError(`Invalid session registry (${detail}). Expected the current schema; no data was modified.`)
  if (typeof data !== 'object' || data === null) throw invalid('file')
  const registry = data as Registry
  if (
    registry.version !== 4 ||
    !Array.isArray(registry.sessions) ||
    typeof registry.creations !== 'object' ||
    registry.creations === null ||
    Object.keys(registry).length !== 3
  )
    throw invalid('file')
  const ids = new Set<string>()
  const names = new Set<string>()
  const active = new Set<string>()
  for (const session of registry.sessions) {
    if (!Value.Check(sessionRecord, session)) {
      const error = [...Value.Errors(sessionRecord, session)][0]
      throw invalid(`a session's ${error?.instancePath || 'record'}: ${error?.message ?? 'invalid'}`)
    }
    const adapter = harness(session.tool)
    if (ids.has(session.id) || names.has(session.name.toLowerCase())) throw invalid('duplicate session')
    ids.add(session.id)
    names.add(session.name.toLowerCase())
    for (const conversation of session.conversations) {
      if (!adapter.validId(conversation.id)) throw invalid('conversation ID')
      if (conversation.movedTo) continue
      // A conversation belongs to at most one session.
      if (active.has(key(session, conversation.id))) throw invalid('conversation in two sessions')
      active.add(key(session, conversation.id))
    }
  }
  for (const [request, receipt] of Object.entries(registry.creations))
    if (!/^[0-9a-f]{64}$/.test(request) || !receipt || !/^[0-9a-f]{64}$/.test(receipt.fingerprint))
      throw invalid('creation receipt')
  return registry
}

export function readRegistry(): Registry {
  return validate(readJson<unknown>(path(), { version: 4, sessions: [], creations: {} }))
}

/** Change the registry under its lock; `change` sees the latest file. */
export function changeRegistry<T>(change: (registry: Registry) => T) {
  return locked('registry', () => {
    const registry = readRegistry()
    const result = change(registry)
    writeJson(path(), validate(registry))
    return result
  })
}

export function session(registry: Registry, id: unknown) {
  const found = registry.sessions.find(item => item.id === id)
  if (!found) throw new RegistryError('Session not found', 404)
  return found
}

export const current = (session: SessionRecord) => session.conversations.at(-1)!

/** The tool made `conversation` current in this session (new, clear, resume).
 * If another session held it, it moves here. `replacing` drops the current
 * conversation, which never started. */
export function switchConversation(registry: Registry, sessionId: string, conversation: string, replacing = false) {
  const target = session(registry, sessionId)
  if (!harness(target.tool).validId(conversation))
    throw new RegistryError('The coding tool reported an invalid conversation ID.')
  const latest = current(target)
  if (latest.id === conversation && !latest.movedTo) return false
  target.conversations = target.conversations.filter(
    item => item.id !== conversation && !(replacing && item === latest),
  )
  target.conversations.push({ id: conversation, startedAt: now(), movedTo: null })
  target.conversations = target.conversations.slice(-200)
  for (const other of registry.sessions)
    if (other !== target)
      for (const item of other.conversations)
        if (!item.movedTo && key(other, item.id) === key(target, conversation)) item.movedTo = target.id
  return true
}
