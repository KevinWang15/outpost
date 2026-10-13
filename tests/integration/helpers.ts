import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import type { ServerMessage } from '../../shared/protocol'
import { quote } from '../../backend/shell'

export const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url))

/** A disposable home with fixture coding tools on its login PATH. */
export async function fixtureHome(prefix: string) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  const home = join(directory, "home with 'quotes")
  const bin = join(home, 'bin')
  await mkdir(bin, { recursive: true })
  for (const tool of ['claude', 'codex', 'kimi']) await copyFile(join(fixtures, 'coding-tool-fixture.py'), join(bin, tool))
  for (const tool of ['claude', 'codex', 'kimi']) await import('node:fs/promises').then(fs => fs.chmod(join(bin, tool), 0o700))
  for (const name of ['.bash_profile', '.zprofile']) await writeFile(join(home, name), `export PATH=${quote(bin)}:"$PATH"\n`)
  await writeFile(join(home, '.hushlogin'), '')
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, SHELL: '/bin/bash', PATH: `${bin}:${process.env.PATH}` }
  delete env.TMUX
  return { directory, home, bin, env }
}

export function api(base: string) {
  return async <T = unknown>(method: string, path: string, body?: unknown, expected = 200): Promise<T> => {
    const response = await fetch(`${base}/api${path}`, {
      method, headers: { 'x-outpost-request': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const text = await response.text()
    assert.equal(response.status, expected, text)
    return (text ? JSON.parse(text) : undefined) as T
  }
}

/** Stop every fixture tmux server under a disposable home, then remove it. */
export async function removeHome(directory: string, home: string) {
  const sockets = join(home, '.outpost', 'sockets')
  for (const name of await readdir(sockets).catch(() => [] as string[])) {
    await new Promise(resolve => execFile('tmux', ['-S', join(sockets, name), 'kill-server'], resolve))
  }
  await rm(directory, { recursive: true, force: true })
}

/** A minimal terminal client speaking the terminal protocol. */
export class TerminalClient {
  output = ''
  messages: ServerMessage[] = []
  socket: WebSocket
  opened: Promise<void>
  closed: Promise<void>
  constructor(url: string) {
    this.socket = new WebSocket(url)
    this.opened = new Promise((resolve, reject) => { this.socket.once('open', () => resolve()); this.socket.once('error', reject) })
    this.closed = new Promise(resolve => this.socket.once('close', () => resolve()))
    this.socket.on('message', (data, binary) => {
      if (binary) {
        const bytes = data as Buffer
        this.output += bytes.toString('utf8')
        this.socket.send(JSON.stringify({ type: 'ack', bytes: bytes.length }))
      } else this.messages.push(JSON.parse(data.toString()))
    })
  }
  async until<T>(check: () => T | undefined | false, label: string, timeout = 15_000): Promise<T> {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const value = check()
      if (value) return value
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error(`Timed out waiting for ${label}. Output: ${this.output.slice(-1500)} Messages: ${JSON.stringify(this.messages)}`)
  }
  message<K extends ServerMessage['type']>(type: K, label = type) {
    return this.until(() => this.messages.find(message => message.type === type) as Extract<ServerMessage, { type: K }> | undefined, label)
  }
  take<K extends ServerMessage['type']>(type: K) {
    return this.until(() => {
      const index = this.messages.findIndex(message => message.type === type)
      return index >= 0 ? this.messages.splice(index, 1)[0] as Extract<ServerMessage, { type: K }> : undefined
    }, type)
  }
  text(marker: string | RegExp) {
    return this.until(() => typeof marker === 'string' ? this.output.includes(marker) : marker.exec(this.output), String(marker))
  }
  send(message: unknown) { this.socket.send(JSON.stringify(message)) }
  input(data: string) { this.socket.send(Buffer.from(data)) }
}
