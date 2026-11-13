// Webhooks: what an account saves, what a receiver gets, and where a hosted server may send.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { LogEvent, WebhookInput, WebhookPayload } from '../../shared/logs'
import type { Deployment } from '../../backend/deployment'
import { Webhooks } from '../../backend/logs/webhooks'

const owner = { userId: 'local', loginId: 'local' }
const event = (overrides: Partial<LogEvent> = {}): LogEvent => ({
  id: crypto.randomUUID(),
  time: '2026-11-14T09:30:00.000Z',
  level: 'info',
  kind: 'agent',
  type: 'status',
  message: 'Coder finished its turn',
  machine: { id: 'm', name: 'Workstation' },
  session: { id: 's', name: 'Coder' },
  details: { state: 'finished' },
  ...overrides,
})

async function setup(t: TestContext, mode: 'local' | 'hosted' = 'local', statuses: number[] = []) {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-webhooks-'))
  const deployment = { mode, workspace: () => ({ directory }) } as unknown as Deployment
  const webhooks = new Webhooks(deployment, [10, 10, 10])
  const received: { headers: IncomingHttpHeaders; body: WebhookPayload }[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => (body += chunk))
    request.on('end', () => {
      received.push({ headers: request.headers, body: JSON.parse(body) })
      response.statusCode = statuses.shift() ?? 204
      response.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`
  t.after(async () => {
    webhooks.close()
    server.close()
    await rm(directory, { recursive: true, force: true })
  })
  const input = (overrides: Partial<WebhookInput> = {}): WebhookInput => ({
    name: 'Alerts',
    url,
    headers: [{ name: 'Authorization', value: 'Bearer secret' }],
    kinds: [],
    level: 'info',
    enabled: true,
    ...overrides,
  })
  const until = async (check: () => boolean) => {
    for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(check(), 'timed out')
  }
  return { directory, webhooks, received, input, until }
}

test('header values are kept on the server and an edit without one keeps it', async t => {
  const { directory, webhooks, input } = await setup(t)
  const created = await webhooks.create(owner, input())
  assert.deepEqual(created.headers, [{ name: 'Authorization' }], 'values are never sent back')
  const edited = await webhooks.update(
    owner,
    created.id,
    input({ name: 'Renamed', headers: [{ name: 'authorization' }] }),
  )
  assert.equal(edited.name, 'Renamed')
  const saved = JSON.parse(await readFile(join(directory, 'webhooks.json'), 'utf8'))
  assert.deepEqual(saved.webhooks[0].headers, [{ name: 'authorization', value: 'Bearer secret' }])
  await assert.rejects(
    webhooks.update(owner, created.id, input({ headers: [{ name: 'X-New' }] })),
    /Enter a value for X-New/,
  )
  await assert.rejects(
    webhooks.create(owner, input({ headers: [{ name: 'Content-Type', value: 'x' }] })),
    /sets Content-Type/,
  )
  await assert.rejects(
    webhooks.create(owner, input({ url: 'https://user:pass@example.com/' })),
    /credentials in a header/,
  )
  await webhooks.remove(owner, created.id)
  assert.deepEqual(await webhooks.list(owner), [])
})

test('a receiver gets Outpost’s body and the owner’s headers, for the kinds and levels it asked for', async t => {
  const { webhooks, received, input, until } = await setup(t)
  await webhooks.create(owner, input({ kinds: ['agent', 'message'], level: 'warning' }))
  webhooks.publish(owner, event()) // Below the level.
  webhooks.publish(owner, event({ kind: 'machine', level: 'error' })) // Another kind.
  webhooks.publish(owner, event({ level: 'error', message: 'Coder stopped with an error' }))
  await until(() => received.length === 1)
  const [{ headers, body }] = received
  assert.equal(headers.authorization, 'Bearer secret')
  assert.equal(headers['content-type'], 'application/json')
  assert.equal(body.version, 1)
  assert.equal(body.webhook.name, 'Alerts')
  assert.equal(body.event.message, 'Coder stopped with an error')
})

test('server errors are retried; a refusal is not; a failure is reported once', async t => {
  const { webhooks, received, input, until } = await setup(t, 'local', [503, 500, 204, 404])
  const failures: string[] = []
  webhooks.failed = (_owner, _webhook, delivery) => failures.push(delivery.error ?? '')
  const created = await webhooks.create(owner, input())
  webhooks.publish(owner, event())
  await until(() => received.length === 3)
  webhooks.publish(owner, event())
  await until(() => failures.length === 1)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(received.length, 4, 'a 404 is not retried')
  assert.deepEqual(failures, ['The receiver answered 404.'])
  assert.equal((await webhooks.list(owner)).find(item => item.id === created.id)?.lastDelivery?.status, 404)
})

test('a hosted server does not send to its own network; a paused webhook gets nothing', async t => {
  const { webhooks, received, input } = await setup(t, 'hosted')
  const created = await webhooks.create(owner, input())
  const delivery = await webhooks.test(owner, created.id, event())
  assert.equal(delivery.ok, false)
  assert.match(delivery.error ?? '', /only reach public addresses/)
  await webhooks.update(owner, created.id, input({ enabled: false }))
  webhooks.publish(owner, event())
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(received.length, 0)
})
