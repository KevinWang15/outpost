// Conversation tracking end to end (docs/CONVERSATIONS.md): the coding tool in a
// session's terminal moves it to another conversation, Logs records the move, and the
// tool starts there again after it stops. Hooks from a background service the tool
// started carry the session's binding but are ignored.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { machineSocket } from '../../backend/machines'
import { createApp } from '../../backend/app'
import { LocalDeployment } from '../../backend/deployment'
import type { LogView } from '../../shared/logs'
import type { Session, Target } from '../../shared/model'
import type { TerminalTicket } from '../../shared/protocol'
import { api, fixtureHome, provisionMachine, removeHome, TerminalClient } from './helpers'

const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test(
  'the terminal’s own coding tool moves its session to another conversation; a background service does not',
  { timeout: 120_000, skip: process.platform !== 'linux' },
  async t => {
    const { directory, home, env } = await fixtureHome('outpost-conversations-')
    const deployment = await LocalDeployment.open(join(directory, 'data'))
    const app = await createApp({ history: false, deployment, env, multiplex: false })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const port = (app.server.address() as { port: number }).port
    const request = api(`http://127.0.0.1:${port}`)
    const clients: TerminalClient[] = []
    t.after(async () => {
      for (const client of clients) client.socket.terminate()
      await app.close()
      await removeHome(directory, home)
    })
    const view = await request<LogView>('GET', '/logs')
    const log = async () => {
      const response = await fetch(
        `http://127.0.0.1:${port}/log-viewer/api/logs/${encodeURIComponent(`s:${view.channel}`)}/entries?from=0&count=200`,
      )
      return ((await response.json()) as { entries: { msg: string }[] }).entries.map(entry => entry.msg)
    }
    const until = async <T>(check: () => Promise<T | undefined | false>, label: string): Promise<T> => {
      for (let attempt = 0; attempt < 300; attempt++) {
        const value = await check()
        if (value) return value
        await settle(100)
      }
      assert.fail(`Timed out waiting for ${label}`)
    }
    const fileText = (name: string) => readFile(join(project, name), 'utf8').catch(() => '')

    const target = await request<Target>('POST', '/targets', { kind: 'local', name: 'Workstation' }, 201)
    provisionMachine(home, machineSocket(deployment.secret, deployment.owner(), target.id))
    await request('GET', `/targets/${target.id}/software`)
    const project = join(home, 'project')
    const session = await request<Session>(
      'POST',
      `/targets/${target.id}/sessions`,
      { name: 'Builder', rootDir: '~/project', tool: 'claude', createDirectory: true },
      201,
    )
    const current = async () =>
      (await request<Session>('GET', `/targets/${target.id}/sessions/${session.id}`)).conversation
    const connect = async () => {
      const { token } = await request<TerminalTicket>(
        'POST',
        `/targets/${target.id}/sessions/${session.id}/connect`,
        {},
      )
      const client = new TerminalClient(
        `ws://127.0.0.1:${port}/api/terminal?token=${encodeURIComponent(token)}&cols=100&rows=30`,
      )
      clients.push(client)
      await client.message('ready')
      await client.text('OUTPOST_FIXTURE_READY')
      return client
    }
    const client = await connect()

    // The tool itself starts a new conversation, as /clear does.
    client.input('clear-conversation\r')
    const cleared = await until(() => fileText('cleared-conversation'), 'the tool’s new conversation')
    assert.notEqual(cleared, session.conversation)
    await until(async () => (await current()) === cleared, 'the session to follow the tool')
    await until(
      async () => (await log()).includes(`Builder moved to conversation ${cleared} in a terminal`),
      'the move in Logs',
    )

    // A background service the tool started reports a conversation of its own.
    client.input('background-conversation\r')
    const background = await until(() => fileText('background-conversation'), 'the background service’s hook')
    await settle(1000)
    assert.equal(await current(), cleared, 'a background service does not move the session')
    assert.ok(!(await log()).some(message => message.includes(background)), 'nor is it logged')

    // After the tool stops, the session starts it again on the conversation it was in.
    await request('POST', `/targets/${target.id}/sessions/${session.id}/terminate`)
    await writeFile(join(project, 'heartbeat.json'), '{}')
    await connect()
    const heartbeat = await until(async () => {
      const beat = JSON.parse((await fileText('heartbeat.json')) || '{}') as { cliSessionId?: string }
      return beat.cliSessionId
    }, 'the restarted tool')
    assert.equal(heartbeat, cleared)
  },
)
