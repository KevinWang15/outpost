import type { TerminalInputResult } from '../shared/web-terminal'

const uncertain = 'Delivery was not confirmed. Your draft is kept; check the terminal before retrying.'

/** Draft submissions wait for acceptance. Live keystrokes remain a stream.
 * Never replay a submission after losing its connection or acknowledgement. */
export class TerminalSubmit {
  private pending: { socket: WebSocket; id: string; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null

  send(socket: WebSocket, data: string): Promise<void> {
    if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Terminal disconnected. Reconnect to send your draft.'))
    if (this.pending) return Promise.reject(new Error('A send is already in progress.'))
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID()
      const timer = setTimeout(() => this.finish(new Error(uncertain)), 10000)
      this.pending = { socket, id, resolve, reject, timer }
      try { socket.send(JSON.stringify({ type: 'input', id, data })) }
      catch { this.finish(new Error('Could not send. Your draft is kept; reconnect and try again.')) }
    })
  }
  receive(socket: WebSocket, result: TerminalInputResult) {
    if (this.pending?.socket !== socket || this.pending.id !== result.id) return
    this.finish(result.accepted ? undefined : new Error(result.message))
  }
  disconnect(socket?: WebSocket) {
    if (!socket || this.pending?.socket === socket) this.finish(new Error(uncertain))
  }
  private finish(error?: Error) {
    const pending = this.pending
    if (!pending) return
    this.pending = null
    clearTimeout(pending.timer)
    if (error) pending.reject(error)
    else pending.resolve()
  }
}
