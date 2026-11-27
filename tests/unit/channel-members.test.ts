import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ChatHub } from '../../backend/chat/hub'
import { LocalDeployment } from '../../backend/deployment'
import { Machines } from '../../backend/machines'
import { targetResolver } from '../../backend/services'
import { SessionFileClient } from '../../backend/sessionFiles'
import type { ChatServerMessage } from '../../shared/chatApi'
import { FakeSessions } from './fakes'

test('channels keep offline members and remove deleted sessions once across channels, including after restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-members-'))
  const deployment = await LocalDeployment.open(directory)
  const machines = new Machines('channel-members')
  const resolve = targetResolver(deployment, machines, false)
  const owner = deployment.owner()
  const sessions = new FakeSessions()
  const target = await deployment.workspace().add({
    id: 'machine',
    kind: 'outbound',
    name: 'Workstation',
    createdAt: new Date().toISOString(),
  })
  const context = await resolve(owner, target.id)
  const [one, two] = await Promise.all(
    ['One', 'Two'].map(name => sessions.create(context, { name, rootDir: '/work', tool: 'codex' })),
  )
  one.driver = two.driver = 'terminal'
  const ref = (sessionId: string) => ({ targetId: target.id, sessionId })
  let offline = false
  const makeHub = () =>
    new ChatHub({
      deployment,
      resolve,
      files: new SessionFileClient(),
      terminals: sessions,
      terminalPollMs: 20,
      connect() {
        throw new Error('Unexpected chat connection')
      },
      list: async context => {
        if (offline) throw new Error('Machine offline')
        return (await sessions.list(context)).sessions
      },
    })
  let hub = makeHub()
  t.after(async () => {
    hub.close()
    machines.close()
    await rm(directory, { recursive: true, force: true })
  })
  const events: ChatServerMessage[] = []
  const client = {
    owner,
    send(event: ChatServerMessage) {
      events.push(structuredClone(event))
    },
  }
  await hub.attach(client)
  await hub.refreshFor(owner)
  const members = [ref(one.id), ref(two.id)]
  const a = await hub.saveChannel(owner, { name: 'first', topic: '', members })
  const b = await hub.saveChannel(owner, { name: 'other', topic: '', members })
  await hub.post(owner, a.id, 'old', 'Keep this in history')
  await sessions.remove(context, one.id)
  offline = true
  hub.close()
  hub = makeHub()
  await hub.attach(client)
  await hub.refreshFor(owner)
  assert.equal((await hub.attach(client)).hello.channels[0].members.length, 2)
  offline = false
  await hub.refreshFor(owner)
  await hub.sessionDeleted(owner, ref(one.id))
  await hub.refreshFor(owner)
  for (const channel of (await hub.attach(client)).hello.channels) {
    assert.deepEqual(
      channel.members.map(member => member.sessionId),
      [two.id],
    )
    const { messages } = await hub.history(owner, channel.id, null)
    assert.deepEqual(
      messages.filter(message => message.author.kind === 'outpost').map(message => message.text),
      ['@one was removed from this channel because the session was deleted.'],
    )
  }
  await assert.rejects(hub.saveChannel(owner, { id: a.id, add: members, remove: [] }), /no longer available/)
  await hub.post(owner, a.id, 'after', '@all hello')
  await t.waitFor(() => assert.equal(sessions.delivered.length, 1))
  assert.deepEqual(
    sessions.delivered.map(item => item.id),
    [two.id],
  )
  // A concurrent settings save cannot put a removed member back into the channel.
  await Promise.all([
    hub.saveChannel(owner, { id: b.id, add: [], remove: [ref(two.id)] }),
    hub.saveChannel(owner, { id: b.id, name: 'renamed', topic: 'New topic' }),
  ])
  const edited = (await hub.attach(client)).hello.channels.find(channel => channel.id === b.id)
  assert.equal(edited?.name, 'renamed')
  assert.deepEqual(edited.members, [])

  const schedule = await hub.saveSchedule(owner, {
    ...ref(two.id),
    name: 'Review',
    prompt: 'Review the build',
    cron: '0 9 * * *',
    timeZone: 'UTC',
    enabled: false,
  })
  await hub.runSchedule(owner, schedule.id)
  await t.waitFor(() =>
    assert.ok(
      events.some(e => e.type === 'delivery' && e.delivery.source.kind === 'schedule' && e.delivery.state === 'sent'),
    ),
  )
  await sessions.remove(context, two.id)
  await hub.sessionDeleted(owner, ref(two.id))
  // The schedule broadcast follows its durable write. The in-memory object changes earlier.
  await t.waitFor(() =>
    assert.ok(
      events.some(
        event => event.type === 'schedule' && event.schedule.id === schedule.id && event.schedule.lastRun?.ok === false,
      ),
    ),
  )
  assert.match(schedule.lastRun?.message ?? '', /session was deleted/i)
  assert.deepEqual(
    (await hub.attach(client)).hello.channels.map(channel => channel.members),
    [[], []],
  )
  const { messages } = await hub.history(owner, a.id, null)
  assert.equal(messages[0].text, 'Keep this in history')
  assert.equal(messages.at(-1)?.text, '@two was removed from this channel because the session was deleted.')
  assert.ok(events.some(event => event.type === 'delivery' && event.delivery.state === 'failed'))
  assert.equal((await hub.history(owner, b.id, null)).messages.at(-1)?.text, '@two left the channel.')
})

test('concurrent and old channel drafts acknowledge only a saved post in the same channel', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-channel-drafts-'))
  const deployment = await LocalDeployment.open(directory)
  const owner = deployment.owner()
  const machines = new Machines('channel-drafts')
  const make = () =>
    new ChatHub({
      deployment,
      resolve: targetResolver(deployment, machines, false),
      terminals: new FakeSessions(),
      files: new SessionFileClient(),
      list: async () => [],
      connect() {
        throw new Error('No machines')
      },
    })
  let hub = make()
  t.after(async () => {
    hub.close()
    machines.close()
    await rm(directory, { recursive: true, force: true })
  })
  const first = await hub.saveChannel(owner, { name: 'first', topic: '', members: [] })
  const second = await hub.saveChannel(owner, { name: 'second', topic: '', members: [] })
  const expired = () => hub.post(owner, first.id, 'draft', 'draft with expired file', ['f'.repeat(32)])
  await Promise.all([assert.rejects(expired(), /expired/), assert.rejects(expired(), /expired/)])
  assert.deepEqual((await hub.history(owner, first.id, null)).messages, [])
  const attached = await hub.stageFile(owner, first.id, 'notes.txt', Buffer.from('work'))
  const send = () => hub.post(owner, first.id, 'draft', 'keep this', [attached.id])
  const [one, two, other] = await Promise.all([
    send(),
    send(),
    hub.post(owner, second.id, 'draft', 'different channel'),
  ])
  assert.equal(one.messageId, two.messageId)
  assert.deepEqual([one.duplicate, two.duplicate].sort(), [false, true])
  assert.notEqual(other.messageId, one.messageId)
  assert.equal(other.duplicate, false)
  const { account } = await hub.attach({ owner, send() {} })
  const [original] = (await hub.history(owner, first.id, null)).messages
  for (let index = 0; index < 500; index++) {
    const id = crypto.randomUUID()
    await account.store.append({ ...original, id, root: id, key: id, files: [] })
  }
  assert.deepEqual(await send(), { messageId: one.messageId, duplicate: true })
  hub.close()
  hub = make()
  assert.deepEqual(await send(), { messageId: one.messageId, duplicate: true })
  assert.deepEqual(
    (await hub.channelFiles(owner, first.id)).map(file => file.id),
    [attached.id],
  )
})
