// Discovered endpoints accept a probe first. Only an authenticated machine
// stream can claim that probe for its original session and enable PTY traffic.
import { randomBytes } from 'node:crypto'
import { connect } from 'node:net'
import { WebSocket, WebSocketServer, type VerifyClientCallbackSync } from 'ws'
import { Connection } from '../shared/node/terminalViewer'
import type { Stream } from '../backend/machines'
import type { TerminalStreamArgs } from '../shared/machine'
import { desktopOrigin } from '../shared/desktopAuth'

type Slot = { session: string; proof: string; timer: NodeJS.Timeout; ws?: WebSocket }
export async function directEndpoint() {
  const configured = process.env.OUTPOST_DIRECT_ORIGIN,
    authority = process.env.OUTPOST_PAIR_ORIGIN
  if (!configured || !authority) return
  const origin = desktopOrigin(configured)
  const port = Number(process.env.OUTPOST_DIRECT_PORT ?? 8844)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid OUTPOST_DIRECT_PORT.')
  const slots = new Map<string, Slot>()
  const server: WebSocketServer = new WebSocketServer({
    host: '127.0.0.1',
    port,
    path: '/api/terminal/direct',
    maxPayload: 512 * 1024,
    perMessageDeflate: false,
    verifyClient: (info => info.origin === authority && server.clients.size < 64) satisfies VerifyClientCallbackSync,
  })
  await new Promise<void>((ok, no) => {
    server.once('listening', ok)
    server.once('error', no)
  })
  server.on('connection', ws => {
    ws.on('error', () => {})
    const timer = setTimeout(() => ws.terminate(), 3000).unref()
    ws.once('close', () => clearTimeout(timer))
    ws.once('message', (raw, binary) => {
      clearTimeout(timer)
      const id = raw.toString(),
        slot = slots.get(id)
      if (binary || !slot || slot.ws) return ws.close(1008, 'Unknown probe')
      slot.ws = ws
      ws.send(JSON.stringify({ proof: slot.proof }))
      // Input before a centrally authorized claim can never reach a PTY.
      ws.once('message', premature)
      ws.once('close', () => {
        if (slots.get(id) === slot) {
          slots.delete(id)
          clearTimeout(slot.timer)
        }
      })
    })
    function premature() {
      ws.close(1008, 'Attachment has not started')
    }
  })
  return {
    origin,
    offer(session: string) {
      if (slots.size >= 32) return null
      const slot = randomBytes(24).toString('base64url'),
        proof = randomBytes(24).toString('base64url')
      const item: Slot = {
        session,
        proof,
        timer: setTimeout(() => {
          slots.delete(slot)
          item.ws?.close()
        }, 10000).unref(),
      }
      slots.set(slot, item)
      return { slot, proof }
    },
    claim(args: TerminalStreamArgs, path: string, hello: Buffer, ended: () => void) {
      const direct = args.direct
      if (!direct) return
      const slot = slots.get(direct),
        ws = slot?.ws
      if (!slot || slot.session !== args.session || !ws || ws.readyState !== WebSocket.OPEN) return
      slots.delete(direct)
      clearTimeout(slot.timer)
      ws.removeAllListeners('message')
      const timer = setTimeout(() => ws.terminate(), 5000).unref()
      ws.once('close', () => {
        clearTimeout(timer)
        ended()
      })
      ws.once('message', (raw, binary) => {
        clearTimeout(timer)
        if (binary || raw.toString() !== 'attach') return ws.close(1008, 'Invalid direct attachment')
        const viewer = new Connection(args.session, ws, {
          activate: () => false,
          logged: () => {},
          forget: () => {},
          filesChanged: () => viewer.send({ type: 'signal', signal: { type: 'files.changed', payload: {} } }),
        })
        viewer.start(terminalStream(path, hello))
      })
      return () => ws.terminate()
    },
  }
}

export function terminalStream(path: string, hello: Buffer): Stream {
  const pty = connect(path)
  const stream: Stream = {
    opened: null,
    onData: fn => {
      pty.on('data', fn)
    },
    onClose: fn => {
      pty.once('close', () => fn(null, null))
    },
    write: bytes => {
      if (pty.writableLength > 2 * 1024 * 1024) pty.destroy()
      else pty.write(bytes)
    },
    pause: () => {
      pty.pause()
    },
    resume: () => {
      pty.resume()
    },
    end: () => pty.destroy(),
  }
  pty.on('error', () => pty.destroy())
  pty.once('connect', () => pty.write(hello))
  return stream
}
