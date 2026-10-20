import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activityLabel,
  activityNeedsAttention,
  activityStates,
  parseSessionActivity,
  unavailableActivity,
  type SessionActivity,
} from '../../shared/activity'
import { TerminalActivity } from '../../frontend/terminal/activity'

const token = (value: string) => value.repeat(64)
const state = (overrides: Partial<SessionActivity> = {}): SessionActivity => ({
  state: 'idle',
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
    assert.equal(activityNeedsAttention(activity), ['finished', 'waiting', 'error'].includes(value))
  }
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
  ])
    assert.equal(parseSessionActivity(value), null)
  assert.equal(activityLabel(state({ state: 'working', observation: 'stale' })), 'Working (last known)')
  assert.equal(unavailableActivity('x'.repeat(5000)).detail?.length, 4096)
  assert.deepEqual(parseSessionActivity(unavailableActivity('failed')), unavailableActivity('failed'))
})

function fixture() {
  const requests: { id: string; resolve(): void; reject(error: Error): void }[] = []
  const changes: (SessionActivity | null)[] = []
  const notices: string[] = []
  const activity = new TerminalActivity(
    {
      acknowledge: id => new Promise<void>((resolve, reject) => requests.push({ id, resolve, reject })),
    },
    value => changes.push(value),
    value => notices.push(value),
  )
  return { activity, requests, changes, notices, current: () => changes.at(-1) }
}

test('activation waits for a fresh observation and never acknowledges approvals or errors', () => {
  const f = fixture()
  f.activity.setActive(true)
  f.activity.update(unavailableActivity('temporary outage'))
  f.activity.update(completion('a', 'stale'))
  assert.equal(f.requests.length, 0)
  f.activity.update(completion())
  assert.equal(f.requests.length, 1)
  assert.equal(f.current()?.state, 'idle')
  f.activity.update(state({ state: 'waiting' }))
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
  assert.equal(f.current()?.completionId, token('b'))
  assert.equal(f.current()?.state, 'finished')
  f.activity.acknowledge()
  assert.equal(f.requests[1].id, token('b'))
  f.requests[1].reject(new Error('offline'))
  await tick()
  assert.equal(f.current()?.state, 'finished')
  assert.equal(f.notices.length, 1)
})

test('reconnection drops old acknowledgement replies and waits for the current generation', async () => {
  const f = fixture()
  f.activity.update(completion())
  f.activity.setActive(true)
  f.activity.update(null)
  f.requests[0].resolve()
  await tick()
  assert.equal(f.current(), null)
  f.activity.update(completion('b'))
  assert.equal(f.requests[1].id, token('b'))
  f.activity.dispose()
  f.requests[1].reject(new Error('disconnected'))
  await tick()
  assert.equal(f.notices.length, 0)
})
