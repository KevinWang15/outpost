import { MessageChannel, type MessagePort, Worker } from 'node:worker_threads'
import type { Embed } from './embeddings'
import type { HistoryIndex } from './index'

export type IndexMethod = Exclude<keyof HistoryIndex, 'db' | 'sourceKey'>
export interface IndexRequest {
  method: IndexMethod
  args: unknown[]
  reply: MessagePort
}

// A dedicated reply port also closes if the worker exits during a request.
export function request<T>(
  target: { postMessage(message: unknown, ports: MessagePort[]): void },
  payload: object,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const { port1, port2 } = new MessageChannel()
    port1.once('message', ({ value, error }) => {
      port1.close()
      if (error !== undefined) reject(new Error(error))
      else resolve(value)
    })
    port1.once('close', () => reject(new Error('History worker closed during a request.')))
    try {
      target.postMessage({ ...payload, reply: port2 }, [port2])
    } catch (error) {
      port1.close()
      port2.close()
      reject(error)
    }
  })
}

export async function respond(reply: MessagePort, operation: () => unknown) {
  try {
    reply.postMessage({ value: await operation() })
  } catch (error) {
    reply.postMessage({ error: error instanceof Error ? error.message : String(error) })
  } finally {
    reply.close()
  }
}

export class HistoryIndexClient {
  private worker?: Worker
  private closed = false
  constructor(
    private path: string,
    private secret: string,
    private embed: Embed,
  ) {}

  call<K extends IndexMethod>(method: K, ...args: Parameters<HistoryIndex[K]>) {
    if (this.closed) throw new Error('History index is closed.')
    if (!this.worker) {
      const source = import.meta.url.endsWith('.ts')
      const worker = new Worker(new URL(source ? './index-worker.ts' : './index-worker.js', import.meta.url), {
        execArgv: source ? ['--import', 'tsx'] : [],
        workerData: { path: this.path, secret: this.secret },
      })
      worker.on('message', ({ reply, text, kind }) => void respond(reply, () => this.embed(text, kind)))
      worker.on('error', error => console.error('History worker failed', error))
      worker.on('exit', () => {
        if (this.worker === worker) this.worker = undefined
      })
      this.worker = worker
    }
    return request<Awaited<ReturnType<HistoryIndex[K]>>>(this.worker, { method, args })
  }

  async close() {
    const worker = this.worker
    this.closed = true
    if (worker) await worker.terminate()
  }
}
