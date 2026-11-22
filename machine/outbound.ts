// The outbound service carries the Outpost node protocol for one enrollment.
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { loginShell } from '../shared/node/loginShell'
import { shellJoin } from '../shared/shell'
import { serverOrigin } from '../shared/serverOrigin'
import type { OutboundEnrollmentInput } from '../shared/model'
import type { OutboundEnrollmentReply } from '../shared/machine'
import {
  validNodeSocket,
  installation,
  installationLock,
  reserveOutbound,
  writeOwnership,
  watchInstallation,
  runtimeLock,
  type OutboundEnrollment,
} from './installation'
async function readLine(prompt: string) {
  process.stderr.write(prompt)
  const input = createInterface({ input: process.stdin, terminal: false })
  try {
    for await (const line of input) return line.trim()
  } finally {
    input.close()
  }
  throw Error('Expected installation input.')
}
export async function enrollOutbound(address: string, targetId: string) {
  const origin = serverOrigin(address)
  const code = await readLine('Outpost enrollment code: ')
  await installationLock(async () => {
    const reservation = await reserveOutbound(origin, targetId)
    if (!reservation) return
    const input: OutboundEnrollmentInput = { targetId, code, secret: reservation.credential.slice(targetId.length + 1) }
    const res = await fetch(origin + '/api/machine/enroll', {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-outpost-request': '1' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(10000),
    }).catch(cause => {
      throw new Error('Could not confirm enrollment. Retry the same enrollment command.', { cause })
    })
    if (res.status === 401) throw new Error('Enrollment was not authorized. Request a new code for this machine.')
    if (res.status === 409) throw new Error('This entry already has an enrollment. Release its owner before retrying.')
    if (!res.ok) throw new Error(`Could not confirm enrollment (HTTP ${res.status}). Retry the enrollment command.`)
    const result = (await res.json().catch(cause => {
      throw new Error('Could not read the enrollment confirmation. Retry the same enrollment command.', { cause })
    })) as OutboundEnrollmentReply | null
    if (result?.targetId !== targetId || !validNodeSocket(result.socket)) throw new Error('Invalid enrollment reply.')
    writeOwnership({
      mode: 'outbound',
      origin,
      targetId,
      credential: reservation.credential,
      socket: result.socket,
    })
  })
  console.log('Outbound machine enrolled.')
}

function connectOnce(enrollment: OutboundEnrollment, signal: AbortSignal): Promise<'stable' | 'retry' | 'revoked'> {
  return new Promise(resolve => {
    const url = new URL('/api/machine/connect', enrollment.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(url, {
      headers: { Authorization: 'Bearer ' + enrollment.credential },
      handshakeTimeout: 10000,
      followRedirects: false,
      perMessageDeflate: false,
      maxPayload: 32 * 1024 * 1024,
    })
    let revoked = false
    ws.on('unexpected-response', (_request, response) => {
      revoked = response.statusCode === 401
      response.destroy()
      ws.terminate()
    })
    let node: ReturnType<typeof spawn> | undefined
    const start = Date.now()
    const abort = () => ws.terminate()
    signal.addEventListener('abort', abort, { once: true })
    let lastContact = Date.now()
    ws.on('ping', () => {
      lastContact = Date.now()
    })
    const watchdog = setInterval(() => {
      if (Date.now() - lastContact > 45000) abort()
    }, 15000).unref()
    ws.on('error', () => {})
    ws.on('message', (data, binary) => {
      lastContact = Date.now()
      if (!node) {
        if (binary || !Buffer.isBuffer(data) || data.length > 256) return ws.close(1002)
        let socket: unknown
        try {
          socket = JSON.parse(data.toString()).socket
        } catch {
          return ws.close(1002)
        }
        if (!validNodeSocket(socket) || socket !== enrollment.socket) return ws.close(1008, 'Incorrect node identity')
        // In a compiled release argv[0] is outpost-terminal; in development it is Bun.
        const args = process.argv[1]?.endsWith('/main.ts')
          ? [process.argv[1], 'node', '--socket', socket]
          : ['node', '--socket', socket]
        node = spawn('sh', ['-c', loginShell('interactive', 'exec ' + shellJoin([process.execPath, ...args]))], {
          stdio: ['pipe', 'pipe', 'inherit'],
        })
        node.once('exit', abort)
        node.once('error', abort)
        node.stdin!.on('error', abort)
        node.stdout!.on('data', (chunk: Buffer) => {
          if (ws.readyState !== WebSocket.OPEN) return
          node!.stdout!.pause()
          // Pipe read size is platform-dependent; each WebSocket message fits the server limit.
          for (let i = 0; i < chunk.length; i += 65536)
            ws.send(chunk.subarray(i, i + 65536), error => {
              if (error) return abort()
              if (i + 65536 >= chunk.length) node?.stdout?.resume()
            })
        })
        return
      }
      if (!binary) return ws.close(1002)
      if (!node.stdin!.write(data)) {
        ws.pause()
        node.stdin!.once('drain', () => ws.resume())
      }
    })
    ws.once('close', () => {
      clearInterval(watchdog)
      signal.removeEventListener('abort', abort)
      node?.stdin?.end()
      node?.kill('SIGTERM')
      resolve(revoked ? 'revoked' : Date.now() - start > 30000 ? 'stable' : 'retry')
    })
  })
}
async function maintainConnection(enrollment: OutboundEnrollment, signal: AbortSignal) {
  let backoff = 500
  while (!signal.aborted) {
    const stable = await connectOnce(enrollment, signal)
    if (stable === 'revoked') {
      console.error('Outpost revoked this machine credential. Release the local enrollment to set it up again.')
      // Keep supervisors from restarting a revoked credential and contacting the server again.
      if (!signal.aborted) await once(signal, 'abort')
      return
    }
    if (stable === 'stable') backoff = 500
    if (!signal.aborted) await delay(backoff + (Math.random() * backoff) / 4, undefined, { signal }).catch(() => {})
    backoff = Math.min(30000, backoff * 2)
  }
}
export async function runOutbound() {
  const initial = installation()
  if (initial?.mode !== 'outbound') throw Error('Enroll this machine first.')
  return runtimeLock(async () => {
    const enrollment = installation()
    if (enrollment?.mode !== 'outbound' || enrollment.generation !== initial.generation)
      throw Error('Installation changed.')
    const stop = new AbortController()
    const shutdown = () => stop.abort()
    const unwatch = watchInstallation(enrollment, shutdown)
    process.once('SIGTERM', shutdown)
    process.once('SIGINT', shutdown)
    try {
      await maintainConnection(enrollment, stop.signal)
    } finally {
      unwatch()
      process.off('SIGTERM', shutdown)
      process.off('SIGINT', shutdown)
    }
  })
}
