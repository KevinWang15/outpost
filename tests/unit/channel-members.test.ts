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
  const target = await deployment
    .workspace()
    .add({ id: 'machine', kind: 'paired', name: 'Workstation', tools: ['codex'], createdAt: new Date().toISOString() })
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
      events.push(event)
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

  await sessions.remove(context, two.id)
  await hub.sessionDeleted(owner, ref(two.id))
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
