import assert from 'node:assert/strict'
import test from 'node:test'
import { compareSessionsByRecency, sessionLastUsedAt } from '../../shared/model'
import {
  desktopEntryUrl,
  desktopSessionId,
  parseDesktopEntry,
  type DesktopSessionChoice,
} from '../../shared/desktopAuth'
import { loadSessionCatalogue, type SessionCatalogue } from '../../desktop/src/server-catalogue'
import { sessionCreationServer } from '../../desktop/src/server-session-creation'
import { ServerApiError } from '../../desktop/src/server-api'

test('public, account and session links use the same Desktop action on macOS and Windows', () => {
  const server = 'https://outpost.example'
  const accountId = 'account'
  const session = { targetId: 'machine', sessionId: 'session' }
  for (const entry of [{ server }, { server, accountId }, { server, accountId, session }]) {
    const url = desktopEntryUrl(entry)
    assert.equal(new URL(url).host, 'server')
    assert.deepEqual(parseDesktopEntry(url), entry)
    assert.deepEqual(parseDesktopEntry(url.replace('?', '/?')), entry)
  }
  const url = desktopEntryUrl({ server })
  for (const query of [
    'target=machine&session=session',
    'account=account&target=machine',
    'account=account&session=session',
    'account=',
    'account=one&account=two',
    'origin=https%3A%2F%2Fanother.example',
    'token=private',
  ])
    assert.throws(() => parseDesktopEntry(url + '&' + query))
  assert.throws(() => parseDesktopEntry(url.replace('://server', '://other')))
})

const choice = (sessionId: string, targetId = 'target'): DesktopSessionChoice => {
  const reference = { server: 'https://example.com', accountId: 'account', targetId, sessionId }
  return { ...reference, id: desktopSessionId(reference), title: sessionId, detail: '', tool: 'claude' }
}
test('catalogue retains failed scopes, replaces successful empty scopes, and drops invalid accounts', async () => {
  let current = true,
    result!: SessionCatalogue
  let requests = 0
  const server = {
    origin: 'https://example.com',
    accountId: 'account',
    current: () => current,
    request: async (path: string) => {
      requests++
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
  const previousRequests = requests
  await loadSessionCatalogue(
    [server],
    new AbortController().signal,
    value => {
      result = value
    },
    previous,
  )
  assert.deepEqual(result.sessions, [])
  assert.deepEqual(result.errors, [])
  assert.equal(requests, previousRequests)
})

test('catalogue and session recency comparators sort most recently used first', async () => {
  const older = {
    name: 'Beta',
    createdAt: '2026-11-20T00:00:00.000Z',
    lastConnectedAt: '2026-11-21T00:00:00.000Z',
    activity: { updatedAt: null },
  }
  const activeChat = {
    name: 'Gamma',
    createdAt: '2026-11-19T00:00:00.000Z',
    lastConnectedAt: null,
    activity: { updatedAt: '2026-11-25T12:00:00.000Z' },
  }
  const brandNew = {
    name: 'Alpha',
    createdAt: '2026-11-26T08:00:00.000Z',
    lastConnectedAt: null,
    activity: { updatedAt: null },
  }
  assert.equal(sessionLastUsedAt(activeChat), '2026-11-25T12:00:00.000Z')
  assert.deepEqual(
    [older, activeChat, brandNew].sort(compareSessionsByRecency).map(item => item.name),
    ['Alpha', 'Gamma', 'Beta'],
  )

  let result!: SessionCatalogue
  const servers = [
    {
      origin: 'https://first.example',
      accountId: 'a1',
      current: () => true,
      request: async (path: string) =>
        path === '/targets'
          ? [{ id: 't1', name: 'T1' }]
          : [
              { sessionId: 'old', targetId: 't1', title: 'Old · T1', detail: '', tool: 'claude', lastUsedAt: 100 },
              { sessionId: 'mid', targetId: 't1', title: 'Mid · T1', detail: '', tool: 'codex', lastUsedAt: 300 },
            ],
    },
    {
      origin: 'https://second.example',
      accountId: 'a2',
      current: () => true,
      request: async (path: string) =>
        path === '/targets'
          ? [{ id: 't2', name: 'T2' }]
          : [
              {
                sessionId: 'newest',
                targetId: 't2',
                title: 'Newest · T2',
                detail: '',
                tool: 'claude',
                lastUsedAt: 500,
              },
              { sessionId: 'tie-a', targetId: 't2', title: 'A tie · T2', detail: '', tool: 'claude', lastUsedAt: 300 },
            ],
    },
  ]
  await loadSessionCatalogue(servers, new AbortController().signal, value => {
    result = value
  })
  assert.deepEqual(
    result.sessions.map(item => item.sessionId),
    ['newest', 'tie-a', 'mid', 'old'],
  )
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

test('creation capability fetches and validates remote directory suggestions', async () => {
  const summary = { origin: 'https://example.com', account: { id: 'account', name: 'Account', email: null } }
  const seen: string[] = []
  const server = sessionCreationServer(summary, async path => {
    seen.push(path)
    return { directories: ['~/dev/', '~/projects/'], truncated: true }
  })
  const result = await server.directories('target', '~/', new AbortController().signal)
  assert.deepEqual(seen, ['/targets/target/directories?path=~%2F'])
  assert.deepEqual(result, { directories: ['~/dev/', '~/projects/'], truncated: true })
  const malformed = sessionCreationServer(summary, async () => ({ directories: [''], truncated: false }))
  await assert.rejects(malformed.directories('target', '~/', new AbortController().signal), /Invalid directory/)
})
