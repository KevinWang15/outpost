// The activity log end to end: what a machine's drivers record reaches the
// account's log through the node, with Outpost's own events around it.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import type { LogView } from '../../shared/logs'
import type { Session, Target } from '../../shared/model'
import type { TerminalTicket } from '../../shared/protocol'
import { createApp } from '../../backend/app'
import { LocalDeployment } from '../../backend/deployment'
import { api, fixtureHome, removeHome, TerminalClient } from './helpers'

test(
  'a terminal session’s start, turn and stop reach the log from its machine',
  { timeout: 120_000, skip: process.platform !== 'linux' },
  async t => {
    const { directory, home, env } = await fixtureHome('outpost-logs-')
    const app = await createApp({
      history: false,
      deployment: await LocalDeployment.open(join(directory, 'data')),
      env,
      multiplex: false,
    })
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
    const messages = async () => {
      const response = await fetch(
        `http://127.0.0.1:${port}/log-viewer/api/logs/${encodeURIComponent(`s:${view.channel}`)}/entries?from=0&count=200`,
      )
      return ((await response.json()) as { entries: { msg: string }[] }).entries.map(entry => entry.msg)
    }
    const until = async (text: string) => {
      for (let attempt = 0; attempt < 300; attempt++) {
        if ((await messages()).includes(text)) return
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      assert.fail(`The log did not show “${text}”: ${JSON.stringify(await messages())}`)
    }

    const target = await request<Target>(
      'POST',
      '/targets',
      { kind: 'local', name: 'Workstation', tools: ['claude'] },
      201,
    )
    await request('GET', `/targets/${target.id}/software`)
    const session = await request<Session>(
      'POST',
      `/targets/${target.id}/sessions`,
      { name: 'Builder', rootDir: '~/builder', tool: 'claude', createDirectory: true },
      201,
    )
    await writeFile(join(home, 'builder', 'answer-prompts'), '')
    await writeFile(join(home, 'builder', 'capture-input'), '')
    const { token } = await request<TerminalTicket>('POST', `/targets/${target.id}/sessions/${session.id}/connect`, {})
    const client = new TerminalClient(
      `ws://127.0.0.1:${port}/api/terminal?token=${encodeURIComponent(token)}&cols=100&rows=30`,
    )
    clients.push(client)
    await client.message('ready')
    await client.text('OUTPOST_FIXTURE_READY')
    await until('A terminal connected to Builder')
    await until('Builder started in a terminal')

    client.input('Check the build\r')
    await until('Builder is working')
    await until('Builder finished its turn')

    await request('POST', `/targets/${target.id}/sessions/${session.id}/terminate`)
    await until('Builder stopped in a terminal')
    const log = await messages()
    assert.ok(
      log.indexOf('Workstation was added') < log.indexOf('Builder was created') &&
        log.indexOf('Builder was created') < log.indexOf('Builder started in a terminal') &&
        log.indexOf('Builder is working') < log.indexOf('Builder finished its turn'),
      JSON.stringify(log),
    )
  },
)
