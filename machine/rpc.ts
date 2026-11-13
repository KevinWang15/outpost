// A bounded, short-lived JSON-RPC connection to a coding tool's own process
// (Codex app-server, an ACP server): newline-delimited JSON over stdio.
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { isRecord } from './stores'

export class JsonRpcProcess {
  private child: ChildProcessByStdio<Writable, Readable, null>
  private buffer = ''
  private sequence = 0
  private waiting = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>()
  private failure: Error | null = null
  private deadline: NodeJS.Timeout

  constructor(command: string[], env: Record<string, string>, cwd: string, timeoutMs = 18_000) {
    this.child = spawn(command[0], command.slice(1), { env, cwd, stdio: ['pipe', 'pipe', 'ignore'], detached: true })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (text: string) => this.receive(text))
    this.child.on('error', error => this.fail(new Error(`Could not start the coding tool: ${error.message}`)))
    this.child.on('exit', () =>
      this.fail(new Error('The coding tool exited during session setup. Check its configuration and login.')),
    )
    this.child.stdin.on('error', () => {})
    this.deadline = setTimeout(
      () =>
        this.fail(
          new Error('The coding tool did not finish session setup in time. Check its configuration and login.'),
        ),
      timeoutMs,
    )
  }

  private receive(text: string) {
    this.buffer += text
    if (this.buffer.length > 1024 * 1024) return this.fail(new Error('The coding tool sent too large a response.'))
    for (let newline = this.buffer.indexOf('\n'); newline >= 0; newline = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        return this.fail(new Error('The coding tool sent an invalid protocol response.'))
      }
      if (!isRecord(message)) continue
      if (typeof message.id === 'number' && ('result' in message || 'error' in message)) {
        const waiter = this.waiting.get(message.id)
        if (!waiter) continue
        this.waiting.delete(message.id)
        if (isRecord(message.error))
          waiter.reject(
            new Error(`The coding tool refused the request: ${String(message.error.message).slice(0, 280)}`),
          )
        else if (isRecord(message.result)) waiter.resolve(message.result)
        else waiter.reject(new Error('The coding tool sent an invalid protocol result.'))
      } else if ('id' in message && 'method' in message)
        // This connection is not an interactive client.
        this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Not supported' } })
    }
  }

  private fail(error: Error) {
    this.failure ??= error
    for (const waiter of this.waiting.values()) waiter.reject(this.failure)
    this.waiting.clear()
  }

  send(message: object) {
    if (!this.failure) this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  call(method: string, params: object): Promise<Record<string, unknown>> {
    if (this.failure) return Promise.reject(this.failure)
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  close() {
    clearTimeout(this.deadline)
    this.fail(new Error('Closed.'))
    this.child.stdin.end()
    const group = this.child.pid
    setTimeout(() => {
      try {
        if (group) process.kill(-group, 'SIGKILL')
      } catch {
        /* Already exited. */
      }
    }, 2000).unref()
  }
}

/** Run `work` with a connection that is always closed afterwards. */
export async function withRpc<T>(
  command: string[],
  env: Record<string, string>,
  cwd: string,
  work: (rpc: JsonRpcProcess) => Promise<T>,
) {
  const rpc = new JsonRpcProcess(command, env, cwd)
  try {
    return await work(rpc)
  } finally {
    rpc.close()
  }
}
