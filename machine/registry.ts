// The machine's sessions (~/.outpost/registry.json). Every writer holds the
// registry lock and replaces the file atomically; readers need no lock.
import { Value } from 'typebox/value'
import type { HarnessId } from '../shared/harnesses'
import type { SessionRecord } from '../shared/model'
import { sessionRecord } from '../shared/schemas'
import { recordEvent } from './events'
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

const key = (tool: HarnessId, storage: string | null, conversation: string) =>
  JSON.stringify([tool, storage, conversation])

/** The native store directory a session uses for `tool` (pinned for its active
 * harness, or resolved from its launch environment for an earlier harness). */
export function sessionStorageFor(session: SessionRecord, tool: HarnessId): string {
  if (session.tool === tool) return Object.values(session.storage)[0]
  const env = { ...(process.env as Record<string, string>), ...session.config.env }
  return harness(tool).home(env, session.rootDir)
}

/** Whether `session` currently owns (non-moved) `conversationId` in `(tool, storageHome)`. */
export function ownsConversation(
  session: SessionRecord,
  tool: HarnessId,
  storageHome: string,
  conversationId: string,
): boolean {
  return (
    sessionStorageFor(session, tool) === storageHome &&
    session.conversations.some(item => item.tool === tool && item.id === conversationId && !item.movedTo)
  )
}

export function findConversationOwner(
  sessions: readonly SessionRecord[],
  tool: HarnessId,
  storageHome: string,
  conversationId: string,
  exceptSessionId?: string,
): SessionRecord | undefined {
  return sessions.find(
    candidate => candidate.id !== exceptSessionId && ownsConversation(candidate, tool, storageHome, conversationId),
  )
}

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
    if (session.conversation !== null) {
      if (!adapter.validId(session.conversation)) throw invalid('conversation ID')
      if (!session.conversations.some(item => item.id === session.conversation && item.tool === session.tool))
        throw invalid('active conversation missing from timeline')
    }
    if (ids.has(session.id) || names.has(session.name.toLowerCase())) throw invalid('duplicate session')
    ids.add(session.id)
    names.add(session.name.toLowerCase())
    const storage = Object.values(session.storage)[0]
    for (const conversation of session.conversations) {
      if (!harness(conversation.tool).validId(conversation.id)) throw invalid('conversation ID')
      if (conversation.movedTo || conversation.tool !== session.tool) continue
      // An active conversation on the session's current harness belongs to at most one session.
      const k = key(conversation.tool, storage, conversation.id)
      if (active.has(k)) throw invalid('conversation in two sessions')
      active.add(k)
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

export function withSessionLock<T>(id: unknown, action: (record: SessionRecord) => T | Promise<T>) {
  const record = session(readRegistry(), id)
  return locked('session-' + record.id, () => action(session(readRegistry(), record.id)), 60_000)
}

/** The active conversation for `session.tool`, or null when the session starts fresh. */
export function current(session: SessionRecord): SessionRecord['conversations'][number] | null {
  if (session.conversation === null) return null
  for (let i = session.conversations.length - 1; i >= 0; i--) {
    const item = session.conversations[i]!
    if (item.id === session.conversation && item.tool === session.tool) return item
  }
  return null
}

/** The newest non-moved remembered conversation for `tool` on this session, if any. */
export function latestConversationFor(session: SessionRecord, tool: HarnessId) {
  for (let i = session.conversations.length - 1; i >= 0; i--) {
    const item = session.conversations[i]!
    if (item.tool === tool && !item.movedTo) return item
  }
  return null
}

/** The session's coding tool moved to `conversation`, in its terminal or in chat: make it
 * current and record the move for Logs (docs/CONVERSATIONS.md). */
export async function followConversation(
  sessionId: string,
  driver: 'terminal' | 'chat',
  conversation: string,
  replacing = false,
) {
  const move = await changeRegistry(registry => {
    const previous = session(registry, sessionId).conversation
    return switchConversation(registry, sessionId, conversation, replacing) ? { previous } : null
  })
  if (move) recordEvent({ type: 'conversation', session: sessionId, driver, conversation, previous: move.previous })
}

/** The tool made `conversation` current in this session (new, clear, resume, or edit).
 * If another session held it on the same harness/store, it moves here. `replacing`
 * drops the current conversation, which never started. */
export function switchConversation(registry: Registry, sessionId: string, conversation: string, replacing = false) {
  const target = session(registry, sessionId)
  if (!harness(target.tool).validId(conversation))
    throw new RegistryError('The coding tool reported an invalid conversation ID.')
  const latest = current(target)
  if (latest && latest.id === conversation && !latest.movedTo && target.conversation === conversation) return false
  target.conversations = target.conversations.filter(
    item => !(item.id === conversation && item.tool === target.tool) && !(replacing && latest && item === latest),
  )
  target.conversations.push({ id: conversation, tool: target.tool, startedAt: now(), movedTo: null })
  target.conversations = target.conversations.slice(-200)
  target.conversation = conversation
  const targetStorage = Object.values(target.storage)[0]
  for (const other of registry.sessions)
    if (other !== target)
      for (const item of other.conversations)
        if (
          !item.movedTo &&
          item.tool === target.tool &&
          item.id === conversation &&
          sessionStorageFor(other, target.tool) === targetStorage
        )
          item.movedTo = target.id
  return true
}
