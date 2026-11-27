import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activityLabel,
  activityStates,
  parseSessionActivity,
  unavailableActivity,
  type SessionActivity,
} from '../../shared/activity'
import { TerminalActivity } from '../../shared/terminal/activity'

const token = (value: string) => value.repeat(64)
const state = (overrides: Partial<SessionActivity> = {}): SessionActivity => ({
  state: 'idle',
  blockedKind: null,
  progress: null,
  updatedAt: null,
  observedAt: '2026-10-21T00:00:00Z',
  completionId: null,
  detail: null,
  observation: 'current',
  ...overrides,
})
const completion = (id = 'a', observation: SessionActivity['observation'] = 'current') =>
  state({ state: 'finished', completionId: token(id), observation })
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test('the activity boundary shares all native states and rejects invalid metadata', () => {
  for (const value of activityStates) {
    const activity = state({ state: value, completionId: value === 'finished' ? token('a') : null })
    assert.deepEqual(parseSessionActivity(activity), activity)
  }
  for (const valid of [
    state({ state: 'working', progress: 0 }),
    state({ state: 'working', progress: 42 }),
    state({ state: 'working', progress: 100 }),
    state({ state: 'waiting', blockedKind: 'permission', progress: 50 }),
    state({ state: 'waiting', blockedKind: 'question' }),
    state({ state: 'waiting', blockedKind: 'auth' }),
  ])
    assert.deepEqual(parseSessionActivity(valid), valid)

  for (const value of [
    null,
    {},
    state({ state: 'bogus' as never }),
    { ...state(), observation: 'maybe' },
    { ...state(), observedAt: 1 },
    state({ completionId: 'unsafe' }),
    state({ completionId: token('a') }),
    state({ state: 'finished' }),
    state({ observation: 'unavailable' }),
    state({ state: 'idle', blockedKind: 'permission' }),
    state({ state: 'working', blockedKind: 'permission' }),
    state({ state: 'waiting', blockedKind: 'dance' as never }),
    state({ state: 'idle', progress: 10 }),
    state({ state: 'finished', completionId: token('a'), progress: 10 }),
    state({ state: 'working', progress: -1 }),
    state({ state: 'working', progress: 101 }),
    state({ state: 'working', progress: 4.5 }),
    { ...state({ state: 'working' }), progress: '50' },
  ])
    assert.equal(parseSessionActivity(value), null)

  assert.equal(activityLabel(state({ state: 'working' })), 'Working')
  assert.equal(activityLabel(state({ state: 'working', progress: 42 })), 'Working · 42%')
  assert.equal(activityLabel(state({ state: 'waiting' })), 'Waiting for you')
  assert.equal(activityLabel(state({ state: 'waiting', blockedKind: 'permission' })), 'Needs approval')
  assert.equal(activityLabel(state({ state: 'waiting', blockedKind: 'question' })), 'Waiting for answer')
  assert.equal(activityLabel(state({ state: 'waiting', blockedKind: 'auth' })), 'Needs sign-in')
  assert.equal(activityLabel(state({ state: 'finished', completionId: token('a') })), 'Needs you')
  assert.equal(activityLabel(state({ state: 'idle' })), 'Idle')
  assert.equal(activityLabel(state({ state: 'error' })), 'Error')
  assert.equal(activityLabel(state({ state: 'unknown' })), 'Unknown')
  assert.equal(unavailableActivity('x'.repeat(5000)).detail?.length, 4096)
  assert.deepEqual(parseSessionActivity(unavailableActivity('failed')), unavailableActivity('failed'))
})

function fixture() {
  const requests: { id: string; resolve(): void; reject(error: Error): void }[] = []
  const notices: string[] = []
  const activity = new TerminalActivity(
    {
      acknowledge: id => new Promise<void>((resolve, reject) => requests.push({ id, resolve, reject })),
    },
    value => notices.push(value),
  )
  return { activity, requests, notices }
}

test('activation waits for a fresh observation and never acknowledges approvals or errors', () => {
  const f = fixture()
  f.activity.setActive(true)
  f.activity.update(unavailableActivity('temporary outage'))
  assert.equal(f.requests.length, 0)
  f.activity.update(completion())
  assert.equal(f.requests.length, 1)
  f.activity.update(state({ state: 'waiting', blockedKind: 'permission' }))
  f.activity.acknowledge()
  f.activity.update(state({ state: 'error' }))
  f.activity.acknowledge()
  assert.equal(f.requests.length, 1)
})

test('only the displayed completion is cleared; new completions require another interaction', async () => {
  const f = fixture()
  f.activity.update(completion())
  f.activity.setActive(true)
  f.activity.update(completion('b'))
  f.requests[0].resolve()
  await tick()
  f.activity.acknowledge()
  assert.equal(f.requests[1].id, token('b'))
  f.requests[1].reject(new Error('offline'))
  await tick()
  assert.equal(f.notices.length, 1)
})

test('reconnection drops old acknowledgement replies and waits for the current generation', async () => {
  const f = fixture()
  f.activity.update(completion())
  f.activity.setActive(true)
  f.activity.update(null)
  f.requests[0].resolve()
  await tick()
  f.activity.update(completion('b'))
  assert.equal(f.requests[1].id, token('b'))
  f.activity.dispose()
  f.requests[1].reject(new Error('disconnected'))
  await tick()
  assert.equal(f.notices.length, 0)
})
