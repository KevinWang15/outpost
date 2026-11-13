// The rules for typing messages into a terminal session, with a fake clock and agent.
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { ActivityState } from '../../shared/activity'
import { activity } from '../../machine/activity'
import { Deliveries, typingPause } from '../../machine/delivery'
import { machine } from './fixtures'

function setup(t: TestContext, mode: 'auto' | 'manual' = 'auto') {
  machine(t)
  const world = { now: 100_000, state: 'idle' as ActivityState, mode, typed: [] as string[], counts: [] as number[] }
  const make = () =>
    new Deliveries('11111111-1111-4111-8111-111111111111', {
      mode: () => world.mode,
      activity: () => activity(world.state),
      type: text => world.typed.push(text),
      reply: () => 'The reply',
      changed: waiting => world.counts.push(waiting),
      now: () => world.now,
    })
  return { world, make, deliveries: make() }
}

test('an idle agent gets the message; its turn ending returns the reply', async t => {
  const { world, deliveries } = setup(t)
  world.state = 'working'
  assert.equal(deliveries.add('a', 'First').state, 'waiting', 'a working agent is not interrupted')
  world.state = 'idle'
  deliveries.tick()
  assert.deepEqual(world.typed, ['First'])
  deliveries.tick()
  assert.equal(deliveries.status(['a'])[0].state, 'typed', 'an unread earlier reply does not end it')
  world.state = 'working'
  deliveries.tick()
  world.state = 'finished'
  deliveries.tick()
  assert.deepEqual(
    deliveries.status(['a']).map(item => [item.state, item.reply]),
    [['done', 'The reply']],
  )
  assert.equal(deliveries.add('a', 'First').state, 'done', 'the same key is not typed again')
  assert.deepEqual(world.typed, ['First'])
})

test('one message at a time; an interrupted or failed turn fails its message', async t => {
  const { world, deliveries } = setup(t)
  deliveries.add('a', 'First')
  deliveries.add('b', 'Second')
  assert.deepEqual(world.typed, ['First'])
  world.state = 'working'
  deliveries.tick()
  world.state = 'idle'
  deliveries.tick()
  assert.equal(deliveries.status(['a'])[0].error, 'The turn was interrupted.')
  // The next one goes in once the agent is idle again.
  assert.deepEqual(world.typed, ['First', 'Second'])
  world.state = 'working'
  deliveries.tick()
  world.state = 'error'
  deliveries.tick()
  assert.equal(deliveries.status(['b'])[0].state, 'failed')
})

test('a message the agent never starts on gives up; an exit fails what is in progress', async t => {
  const { world, deliveries } = setup(t)
  deliveries.add('a', 'Lost in a menu')
  world.now += 61_000
  deliveries.tick()
  assert.match(deliveries.status(['a'])[0].error ?? '', /did not start/)
  deliveries.add('b', 'Interrupted by exit')
  deliveries.exited()
  assert.match(deliveries.status(['b'])[0].error ?? '', /exited/)
})

test('typing, an unfinished line and a draft hold messages; Deliver now does not wait for them', async t => {
  const { world, deliveries } = setup(t)
  deliveries.input('\x1b[A') // An arrow key opens no line.
  world.now += typingPause
  deliveries.input('\x1b[I')
  deliveries.add('a', 'Held')
  assert.deepEqual(world.typed, [], 'just typed')
  world.now += typingPause
  deliveries.tick()
  assert.deepEqual(world.typed, ['Held'])
  world.state = 'working'
  deliveries.tick()
  world.state = 'finished'
  deliveries.tick()

  deliveries.input('half a line')
  world.now += typingPause * 10
  deliveries.add('b', 'After the line')
  assert.equal(world.typed.length, 1, 'an unfinished line holds it')
  deliveries.input('\x03') // Ctrl+C clears the line.
  world.now += typingPause
  deliveries.tick()
  assert.equal(world.typed.at(-1), 'After the line')
  world.state = 'working'
  deliveries.tick()
  world.state = 'idle'
  deliveries.tick()

  deliveries.draft('viewer', true)
  world.now += typingPause
  deliveries.add('c', 'After the draft')
  assert.equal(world.typed.at(-1), 'After the line', 'a draft holds it')
  deliveries.deliverNow()
  assert.equal(world.typed.at(-1), 'After the draft', 'Deliver now does not wait for the draft')
})

test('manual mode holds messages until Deliver now; the queue survives a restart', async t => {
  const { world, deliveries, make } = setup(t, 'manual')
  deliveries.add('a', 'One')
  deliveries.add('b', 'Two')
  assert.deepEqual(world.typed, [])
  assert.equal(world.counts.at(-1), 2)
  const restarted = make()
  assert.equal(restarted.count, 2)
  restarted.deliverNow()
  assert.deepEqual(world.typed, ['One'], 'one at a time, the oldest first')
  assert.equal(restarted.count, 1)
})
