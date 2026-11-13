// The machine's event log: what drivers record, read by cursor across rotation.
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import test from 'node:test'
import { saveActivity, activity } from '../../machine/activity'
import { readEvents, recordEvent } from '../../machine/events'
import { statePath } from '../../machine/state'
import { machine, uuid } from './fixtures'

const started = { type: 'started', session: uuid, driver: 'terminal' } as const

test('reading starts at the end, then returns each event once, in order', t => {
  machine(t)
  assert.deepEqual(readEvents(null), { events: [], cursor: '0:0', more: false }, 'nothing recorded yet')
  recordEvent(started)
  const first = readEvents(null)
  assert.deepEqual(first.events, [], 'what happened before Outpost first looked is not replayed')
  recordEvent({ type: 'exited', session: uuid, driver: 'terminal', code: 0 })
  const next = readEvents(first.cursor)
  assert.deepEqual(
    next.events.map(event => event.type),
    ['exited'],
  )
  assert.ok(Date.parse(next.events[0].at))
  assert.deepEqual(readEvents(next.cursor).events, [], 'read once')
})

test('a state change is recorded; saving the same state again is not', t => {
  machine(t)
  const cursor = readEvents(null).cursor
  saveActivity(uuid, { conversation: 'c', last: activity('working'), seen: [] })
  saveActivity(uuid, { conversation: 'c', last: activity('working'), seen: ['seen'] })
  saveActivity(uuid, { conversation: 'c', last: activity('error', null, null, 'The tool crashed.'), seen: [] })
  const { events } = readEvents(cursor)
  assert.deepEqual(
    events.map(event => event.type === 'activity' && [event.previous, event.state, event.detail]),
    [
      [null, 'working', null],
      ['working', 'error', 'The tool crashed.'],
    ],
  )
})

test('a line still being written waits; a rotated log is finished before the new one', t => {
  machine(t)
  recordEvent(started)
  const path = statePath('events', 'events.ndjson')
  let cursor = readEvents(null).cursor
  appendFileSync(path, '{"type":"started","at":"2026-11-14T00:00:00.000Z","session":"')
  assert.deepEqual(readEvents(cursor).events, [], 'a partial line is not read')
  appendFileSync(path, `${uuid}","driver":"chat"}\n`)
  const read = readEvents(cursor)
  assert.equal(read.events.length, 1)
  cursor = read.cursor
  // Past the size limit the log rotates; events on both sides of it arrive.
  appendFileSync(path, `${JSON.stringify({ ...started, at: '2026-11-14T00:00:01.000Z' })}\n`)
  appendFileSync(path, 'x'.repeat(4 * 1024 * 1024) + '\n')
  recordEvent({ type: 'exited', session: uuid, driver: 'chat', code: 1 })
  let events: ReturnType<typeof readEvents>['events'] = []
  for (let more = true; more;) {
    const page = readEvents(cursor)
    events.push(...page.events)
    cursor = page.cursor
    more = page.more
  }
  events = events.filter(event => event.session === uuid)
  assert.deepEqual(
    events.map(event => event.type),
    ['started', 'exited'],
  )
  assert.deepEqual(readEvents(cursor).events, [])
})
