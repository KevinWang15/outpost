import assert from 'node:assert/strict'
import test from 'node:test'
import { desktopSessionId, type DesktopSessionChoice } from '../../shared/desktopAuth'
import { loadSessionCatalogue, type SessionCatalogue } from '../../desktop/src/server-catalogue'
import { sessionCreationServer } from '../../desktop/src/server-session-creation'
import { ServerApiError } from '../../desktop/src/server-api'

const choice = (sessionId: string, targetId = 'target'): DesktopSessionChoice => {
  const reference = { server: 'https://example.com', accountId: 'account', targetId, sessionId }
  return { ...reference, id: desktopSessionId(reference), title: sessionId, detail: '', tool: 'claude' }
}
test('catalogue retains failed scopes, replaces successful empty scopes, and drops invalid accounts', async () => {
  let current = true,
    result!: SessionCatalogue
  const server = {
    origin: 'https://example.com',
    accountId: 'account',
    current: () => current,
    request: async (path: string) => {
      if (path === '/targets')
        return [
          { id: 'failed', name: 'Failed' },
          { id: 'empty', name: 'Empty' },
        ]
      if (path.includes('/failed/')) throw Error('Offline')
      return []
    },
  }
  const previous = [choice('keep', 'failed'), choice('remove', 'empty'), choice('gone-target', 'gone')]
  await loadSessionCatalogue(
    [server],
    new AbortController().signal,
    value => {
      result = value
    },
    previous,
  )
  assert.deepEqual(
    result.sessions.map(item => item.sessionId),
    ['keep'],
  )
  assert.equal(result.errors.length, 1)
  current = false
  await loadSessionCatalogue(
    [server],
    new AbortController().signal,
    value => {
      result = value
    },
    previous,
  )
  assert.deepEqual(result.sessions, [])
})

test('creation capability sends the request identity and validates display metadata', async () => {
  const summary = { origin: 'https://example.com', account: { id: 'account', name: 'Account', email: null } }
  const calls: unknown[] = []
  const server = sessionCreationServer(summary, async (path, options) => {
    calls.push({ path, options })
    return { sessionId: 'created', targetId: 'target', title: 'Created', detail: 'codex', tool: 'codex' }
  })
  const input = { name: 'Created', rootDir: '/tmp', tool: 'codex' as const }
  const result = await server.create('target', input, 'request-id')
  assert.deepEqual(calls, [{ path: '/targets/target/sessions', options: { body: { requestId: 'request-id', input } } }])
  assert.equal(result.id, choice('created').id)
  assert.equal(result.title, 'Created')
  const bad = sessionCreationServer(summary, async () => ({ sessionId: 'created', targetId: 'wrong' }))
  await assert.rejects(bad.create('target', input, 'request-id'), /could not be confirmed/)
  const expired = sessionCreationServer(summary, async () => {
    throw new ServerApiError('Expired', 401)
  })
  await assert.rejects(expired.create('target', input, 'request-id'), /Expired/)
})
