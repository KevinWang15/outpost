import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { desktopSessionId, type DesktopSessionChoice } from '../../shared/desktopAuth'
import { SessionFinderFlow, type SessionFinderActions } from '../../desktop/src/session-finder-flow'
import { loadSessionCatalogue, type SessionCatalogue } from '../../desktop/src/server-catalogue'
import { sessionCreationServer } from '../../desktop/src/server-session-creation'
import { ServerApiError } from '../../desktop/src/server-api'

const choice = (sessionId: string, targetId = 'target'): DesktopSessionChoice => {
  const reference = { server: 'https://example.com', accountId: 'account', targetId, sessionId }
  return { ...reference, id: desktopSessionId(reference), title: sessionId, detail: '' }
}
function fixture(actions: Partial<SessionFinderActions> = {}) {
  let finished = 0
  const flow = new SessionFinderFlow('Open', {
    load: async (_signal, publish) => publish({ sessions: [choice('old')], errors: [] }),
    create: async () => choice('new'),
    open: async () => {},
    changed: () => {},
    finished: () => {
      finished++
    },
    ...actions,
  })
  return { flow, finished: () => finished }
}

test('confirmed creation stays first even through failed or lagging refreshes', async () => {
  let fail = false
  const { flow } = fixture({
    load: async (_signal, publish) => {
      if (fail) throw Error('Offline')
      publish({ sessions: [choice('old')], errors: [] })
    },
  })
  flow.refresh()
  await setImmediate()
  fail = true
  await flow.create()
  await setImmediate()
  assert.deepEqual(
    flow.state.sessions.map(item => item.sessionId),
    ['new', 'old'],
  )
  assert.equal(flow.state.focusId, choice('new').id)
  assert.deepEqual(flow.state.errors, ['Offline'])
  fail = false
  flow.refresh()
  await setImmediate()
  assert.deepEqual(
    flow.state.sessions.map(item => item.sessionId),
    ['new', 'old'],
  )
})

test('cancelled creation still refreshes discovery without resolving the picker', async () => {
  let loads = 0
  const { flow, finished } = fixture({
    create: async () => null,
    load: async (_signal, publish) => {
      loads++
      publish({ sessions: [choice('created-with-lost-response')], errors: [] })
    },
  })
  await flow.create()
  await setImmediate()
  assert.equal(loads, 1)
  assert.equal(finished(), 0)
  assert.equal(flow.state.sessions[0].sessionId, 'created-with-lost-response')
})

test('new refresh invalidates late catalogue responses, and finish aborts pending discovery', async () => {
  const pending: { signal: AbortSignal; publish(catalogue: SessionCatalogue): void; resolve(): void }[] = []
  const { flow, finished } = fixture({
    load: (signal, publish) => new Promise(resolve => pending.push({ signal, publish, resolve })),
  })
  flow.refresh()
  flow.refresh()
  assert.equal(pending[0].signal.aborted, true)
  pending[1].publish({ sessions: [choice('current')], errors: [] })
  pending[0].publish({ sessions: [choice('stale')], errors: ['stale error'] })
  assert.equal(flow.state.sessions[0].sessionId, 'current')
  flow.finish()
  flow.finish()
  assert.equal(finished(), 1)
  assert.equal(pending[1].signal.aborted, true)
  pending.forEach(item => item.resolve())
  await setImmediate()
  assert.equal(flow.state.sessions[0].sessionId, 'current')
})

test('failed open is retryable; duplicate choices cannot start concurrent connections', async () => {
  let reject!: (reason: Error) => void,
    count = 0
  const { flow, finished } = fixture({
    open: () => {
      count++
      return count === 1
        ? new Promise((_resolve, failure) => {
            reject = failure
          })
        : Promise.resolve()
    },
  })
  flow.refresh()
  await setImmediate()
  const pending = flow.choose(choice('old').id)
  await flow.choose(choice('old').id)
  assert.equal(count, 1)
  reject(Error('Offline'))
  await pending
  assert.equal(flow.state.actionError, 'Offline')
  assert.equal(flow.state.busy, 'idle')
  assert.equal(finished(), 0)
  await flow.choose(choice('old').id)
  assert.equal(count, 2)
  assert.equal(finished(), 1)
})

test('cancellation aborts authorization and ignores late creation and connection results', async () => {
  let complete!: () => void, signal!: AbortSignal
  const { flow, finished } = fixture({
    open: (_session, value) => {
      signal = value
      return new Promise(resolve => {
        complete = resolve
      })
    },
  })
  flow.refresh()
  await setImmediate()
  const opening = flow.choose(choice('old').id)
  flow.finish()
  assert.equal(signal.aborted, true)
  complete()
  await opening
  assert.equal(finished(), 1)
  let created!: (session: DesktopSessionChoice) => void
  const other = fixture({
    create: () =>
      new Promise(resolve => {
        created = resolve
      }),
  })
  const creating = other.flow.create()
  other.flow.finish()
  created(choice('late'))
  await creating
  assert.deepEqual(other.flow.state.sessions, [])
  assert.equal(other.finished(), 1)
})

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
    return { sessionId: 'created', targetId: 'target', title: 'Created', detail: 'codex' }
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
