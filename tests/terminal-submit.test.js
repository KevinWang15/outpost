import assert from 'node:assert/strict'
import test from 'node:test'
import { TerminalSubmit } from '../frontend/terminal-submit.ts'

const connection = () => ({ readyState: WebSocket.OPEN, messages: [], send(data) { this.messages.push(JSON.parse(data)) } })

test('composer submissions settle only for a matching server acknowledgement and retain failures', async () => {
  const sender = new TerminalSubmit(), socket = connection(), other = connection()
  let finished = false
  const first = sender.send(socket, 'draft\r').then(() => { finished = true })
  const id = socket.messages[0].id
  await assert.rejects(sender.send(socket, 'duplicate\r'), /already in progress/)
  sender.receive(other, { type: 'input-result', id, accepted: true })
  sender.receive(socket, { type: 'input-result', id: 'unrelated', accepted: true })
  await Promise.resolve()
  assert.equal(finished, false)
  sender.receive(socket, { type: 'input-result', id, accepted: true })
  await first
  assert.equal(finished, true)
  assert.equal(socket.messages.length, 1)
  const failure = assert.rejects(sender.send(socket, 'retained draft\r'), /Terminal input is busy/)
  sender.receive(socket, { type: 'input-result', id: socket.messages[1].id, accepted: false, message: 'Terminal input is busy' })
  await failure
})

test('disconnects, timeouts and socket errors reject without replay; late replies cannot clear a newer draft', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const sender = new TerminalSubmit(), socket = connection(), next = connection()
  const disconnected = assert.rejects(sender.send(socket, 'first\r'), /Delivery was not confirmed/)
  const oldId = socket.messages[0].id
  sender.disconnect(socket)
  await disconnected
  const timedOut = assert.rejects(sender.send(next, 'second\r'), /Delivery was not confirmed/)
  sender.receive(next, { type: 'input-result', id: oldId, accepted: true })
  sender.disconnect(socket)
  t.mock.timers.tick(10000)
  await timedOut
  assert.equal(socket.messages.length, 1)
  assert.equal(next.messages.length, 1)
  await assert.rejects(sender.send({ ...connection(), send() { throw new Error('network') } }, 'third\r'), /Could not send/)
  await assert.rejects(sender.send({ ...connection(), readyState: WebSocket.CLOSED }, 'fourth\r'), /disconnected/)
  sender.disconnect()
})
