import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { chatProtocol, type ChatServerMessage, type SessionRef } from '../../shared/chatApi'
import type { ChatEntry } from '../../shared/chatHost'
import type { SessionFile } from '../../shared/sessionFiles'
import { TerminalClient } from './helpers'

async function until<T>(read: () => T | undefined | Promise<T | undefined>, label: string, timeout = 20_000) {
  const end = Date.now() + timeout
  do {
    const value = await read()
    if (value !== undefined) return value
    await delay(100)
  } while (Date.now() < end)
  throw Error('Timed out waiting for ' + label)
}

async function viewer(origin: string, headers: Record<string, string>) {
  const socket = new WebSocket(origin.replace(/^http/, 'ws') + '/api/chat?protocol=' + chatProtocol, { headers })
  const messages: ChatServerMessage[] = []
  socket.on('message', data => messages.push(JSON.parse(data.toString())))
  const hello = await until(() => messages.find(message => message.type === 'hello'), 'chat authorization')
  return {
    token: hello.token,
    async call<T>(type: string, fields: object): Promise<T> {
      const id = randomUUID()
      socket.send(JSON.stringify({ type, id, ...fields }))
      const result = await until(
        () =>
          messages.find((m): m is Extract<ChatServerMessage, { type: 'result' }> => m.type === 'result' && m.id === id),
        'answer to ' + type,
      )
      assert.equal(result.ok, true, result.message ?? type)
      return result.data as T
    },
    entry<T extends ChatEntry['kind']>(kind: T) {
      return until(
        () =>
          messages
            .flatMap(m => (m.type === 'entry' ? [m.entry] : m.type === 'journal' ? m.journal.entries : []))
            .find((e): e is Extract<ChatEntry, { kind: T }> => e.kind === kind),
        kind,
      )
    },
    async close() {
      if (socket.readyState === WebSocket.OPEN) {
        const closed = once(socket, 'close')
        socket.close()
        await closed
      }
    },
  }
}

/** Exercise the same product paths over each enrollment, including work due with no open page. */
export async function exerciseMachineChat(origin: string, ref: SessionRef, headers: Record<string, string> = {}) {
  let page = await viewer(origin, headers)
  try {
    await page.call('open', { ...ref, start: true })
    const ticket = await fetch(`${origin}/api/targets/${ref.targetId}/sessions/${ref.sessionId}/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-outpost-request': '1', ...headers },
      body: '{}',
    })
    if (!ticket.ok) assert.fail('Could not issue an ACP terminal ticket: ' + (await ticket.text()))
    const { token } = (await ticket.json()) as { token: string }
    const terminal = new TerminalClient(
      origin.replace(/^http/, 'ws') + '/api/terminal?token=' + encodeURIComponent(token),
    )
    try {
      await terminal.message('ready')
      const pixels = await readFile('public/favicon-32x32.png')
      await terminal.pasteImage(await terminal.uploadImage(pixels))
      await terminal.text('[Image 1]')
      terminal.input('identify clipboard pixels\r')
      await terminal.text('clipboard sha256 ' + createHash('sha256').update(pixels).digest('hex'))
    } finally {
      terminal.socket.close()
      await terminal.closed
    }
    await page.call('prompt', { ...ref, key: randomUUID(), text: 'permission', files: [] })
    const permission = await page.entry('permission')
    await page.close()
    page = await viewer(origin, headers)
    await page.call('open', { ...ref, start: false })
    assert.equal((await page.entry('permission')).id, permission.id)
    await page.call('permission', { ...ref, request: permission.id, optionId: 'allow' })
    assert.equal((await page.entry('resolved')).optionId, 'allow')
    const channel = await page.call<{ id: string }>('channel-save', {
      channel: { name: 'machine-check', topic: '', members: [ref] },
    })
    await page.call('channel-post', {
      channelId: channel.id,
      key: randomUUID(),
      text: '@all publish channel.txt',
      files: [],
    })
    const schedule = await page.call<{ id: string }>('schedule-save', {
      schedule: {
        ...ref,
        name: 'Unattended',
        prompt: 'publish unattended.txt',
        cron: '* * * * *',
        timeZone: 'UTC',
        enabled: true,
      },
    })
    const headersForFiles = { authorization: 'Bearer ' + page.token, ...headers }
    await page.close()
    const path = origin + '/api/chat/files/' + ref.targetId + '/' + ref.sessionId
    const files = await until(
      async () => {
        const response = await fetch(path, { headers: headersForFiles })
        assert.equal(response.status, 200)
        const files = (await response.json()) as SessionFile[]
        return ['channel.txt', 'unattended.txt'].every(name => files.some(file => file.name === name))
          ? files
          : undefined
      },
      'agent MCP publication from a channel and a scheduled prompt',
      95_000,
    )
    for (const name of ['channel.txt', 'unattended.txt']) {
      const file = files.find(file => file.name === name)!
      assert.equal(
        await (await fetch(path + '/' + file.id, { headers: headersForFiles })).text(),
        'Fixture file ' + name + '\n',
      )
    }
    page = await viewer(origin, headers)
    await page.call('schedule-delete', { scheduleId: schedule.id })
    await page.call('channel-delete', { channelId: channel.id })
    await page.call('open', { ...ref, start: false })
    await page.call('stop', ref)
  } finally {
    await page.close()
  }
}
