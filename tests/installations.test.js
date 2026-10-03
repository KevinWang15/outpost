import assert from 'node:assert/strict'
import test from 'node:test'
import { Installations } from '../backend/installations.ts'

const target = { id: 'target' }
const read = async stream => {
  let text = ''
  for await (const chunk of stream) text += chunk
  return text.trim().split('\n').map(JSON.parse)
}
test('installation history is bounded and isolated by target; exceptions and shutdown have terminal statuses', async () => {
  const jobs = new Installations({ install: async (_target, _script, output) => { output('old'.repeat(200_000)); output(' retained tail\n'); return 0 } })
  const job = jobs.start(target, 'dtach', 'script')
  await new Promise(resolve => setImmediate(resolve))
  const events = await read(jobs.events(target.id, job.id))
  const log = events.filter(event => event.type === 'output').map(event => event.text).join('')
  assert.ok(log.length < 256 * 1024 + 100)
  assert.match(log, /Earlier output omitted/)
  assert.ok(log.endsWith('retained tail\n'))
  assert.equal(events.at(-1).installation.status, 'succeeded')
  assert.throws(() => jobs.events('another', job.id), { statusCode: 404 })
  await jobs.close()
  const failed = new Installations({ install: async () => { throw new Error('SSH unavailable') } })
  failed.start(target, 'dtach', 'script')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(failed.latest(target.id).status, 'failed')
  assert.equal(failed.latest(target.id).error, 'SSH unavailable')
  await failed.close()
  const cancelled = new Installations({ install: async (_target, _script, _output, signal) => {
    if (signal.aborted) throw new Error('Manager stopped')
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    throw new Error('Manager stopped')
  } })
  cancelled.start(target, 'dtach', 'script')
  await cancelled.close()
  assert.equal(cancelled.latest(target.id), null)
  assert.throws(() => cancelled.start(target, 'dtach', 'script'), { statusCode: 503 }, 'shutdown must not miss an installation started by a late request')
})
