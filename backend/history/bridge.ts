import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { BoundedWriter } from '../../shared/node/boundedWriter'
import { FrameDecoder, relayMagic, terminalControl } from '../../shared/node/terminalFrames'
import type { Command } from '../process'

/** One authenticated SSH control connection per account and target. */
export class HistoryBridge {
  private child: ChildProcessWithoutNullStreams
  private writer: BoundedWriter
  private decoder = new FrameDecoder()
  private prelude: Buffer = Buffer.alloc(0)
  private ready = false
  private closed = false
  private pending = new Set<string>()
  private window = { until: 0, count: 0 }
  private startup: NodeJS.Timeout
  constructor(
    command: Command,
    env: NodeJS.ProcessEnv | undefined,
    private call: (tool: string, args: unknown) => Promise<unknown>,
    private ended: () => void,
  ) {
    this.child = spawn(command.executable, command.args, { stdio: ['pipe', 'pipe', 'pipe'], env })
    this.writer = new BoundedWriter(this.child.stdin, 4 * 1024 * 1024, 30000, () => this.close())
    this.child.stdin.on('error', () => this.close())
    this.child.stdout.on('data', (data: Buffer) => this.receive(data))
    this.child.stderr.resume()
    this.child.on('error', () => this.close())
    this.child.on('close', () => this.close())
    this.startup = setTimeout(() => this.close(), 20000).unref()
    if (command.input) this.writer.write(command.input)
  }
  private receive(data: Buffer) {
    if (this.closed) return
    if (!this.ready) {
      this.prelude = Buffer.concat([this.prelude, data]).subarray(-65536)
      const at = this.prelude.indexOf(relayMagic)
      if (at < 0) return
      data = this.prelude.subarray(at + relayMagic.length)
      this.prelude = Buffer.alloc(0)
      this.ready = true
      clearTimeout(this.startup)
    }
    try {
      for (const frame of this.decoder.feed(data)) {
        if (frame.kind !== 'C' || frame.payload.length > 65536) throw new Error('Invalid MCP frame')
        const request = JSON.parse(frame.payload.toString())
        if (
          request?.type !== 'call' ||
          typeof request.id !== 'string' ||
          !/^[a-f0-9]{32}$/.test(request.id) ||
          typeof request.tool !== 'string'
        )
          throw new Error('Invalid MCP call')
        if (this.pending.has(request.id)) continue
        const now = Date.now()
        if (now >= this.window.until) this.window = { until: now + 60000, count: 0 }
        if (this.pending.size >= 16 || ++this.window.count > 120) {
          this.answer(request.id, { ok: false, message: 'Too many history requests. Retry shortly.' })
          continue
        }
        this.pending.add(request.id)
        void this.call(request.tool, request.arguments)
          .then(
            data => this.answer(request.id, { ok: true, data }),
            error => this.answer(request.id, { ok: false, message: (error as Error).message.slice(0, 1000) }),
          )
          .finally(() => this.pending.delete(request.id))
      }
    } catch {
      this.close()
    }
  }
  private answer(id: string, result: object) {
    if (!this.closed) this.writer.write(terminalControl({ type: 'result', id, ...result }))
  }
  close() {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.startup)
    this.writer.dispose()
    this.child.stdin.destroy()
    this.child.stdout.destroy()
    this.child.stderr.destroy()
    this.child.kill('SIGTERM')
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 3000).unref()
    this.child.once('close', () => clearTimeout(timer))
    this.ended()
  }
}
