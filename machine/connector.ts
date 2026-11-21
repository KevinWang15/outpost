// A relay-enabled machine dials one configured deployment. Only the Outpost node
// protocol is carried on this link. Each reconnect starts a fresh node while
// the machine's terminal and chat processes keep their sessions.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { desktopOrigin } from '../shared/desktopAuth'
import {
  validNodeSocket,
  validRelayIdentity,
  installation,
  installationLock,
  requireUnpaired,
  writeInstallation,
  watchInstallation,
  runtimeLock,
  validateDirect,
  type RelayInstall,
} from './installation'
import { serveDirectOnly } from './directOnly'
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
export async function installDirect() {
  const config = validateDirect(JSON.parse(await readLine('Offline enrollment JSON: ')))
  await installationLock(async () => {
    await requireUnpaired()
    writeInstallation(config)
  })
  console.log('Direct-only machine enrolled. Run outpost-terminal connect.')
}
export async function pairTarget(address: string) {
  const origin = desktopOrigin(address)
  await installationLock(requireUnpaired)
  const code = await readLine('Outpost pairing code: ')
  await installationLock(async () => {
    await requireUnpaired()
    const res = await fetch(origin + '/api/paired/enroll', {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-outpost-request': '1' },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) throw new Error('Pairing failed. Generate a new code on the Outpost server.')
    const pair = (await res.json()) as RelayInstall
    if (!validRelayIdentity(pair)) throw new Error('Invalid pairing reply.')
    writeInstallation({
      mode: 'relay',
      origin,
      targetId: pair.targetId,
      credential: pair.credential,
      socket: pair.socket,
    })
  })
  console.log('Relay-enabled machine enrolled. Run outpost-terminal connect to keep this machine online.')
}

function connectOnce(pair: RelayInstall, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    const url = new URL('/api/paired/node', desktopOrigin(pair.origin))
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(url, {
      headers: { Authorization: 'Bearer ' + pair.credential },
      handshakeTimeout: 10000,
      followRedirects: false,
      perMessageDeflate: false,
      maxPayload: 32 * 1024 * 1024,
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
        if (!validNodeSocket(socket) || socket !== pair.socket) return ws.close(1008, 'Incorrect node identity')
        // In a compiled release argv[0] is outpost-terminal; in development it is Bun.
        const args = process.argv[1]?.endsWith('/main.ts')
          ? [process.argv[1], 'node', '--socket', socket]
          : ['node', '--socket', socket]
        node = spawn(process.execPath, args, {
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
      resolve(Date.now() - start > 30000)
    })
  })
}
export async function runConnector() {
  const initial = installation()
  if (!initial || (initial.mode !== 'relay' && initial.mode !== 'direct')) throw Error('Enroll this machine first.')
  return runtimeLock(async () => {
    const pair = installation()
    if (!pair || pair.generation !== initial.generation || (pair.mode !== 'relay' && pair.mode !== 'direct'))
      throw Error('Installation changed.')
    const stop = new AbortController()
    const shutdown = () => stop.abort()
    const unwatch = watchInstallation(pair, shutdown)
    process.once('SIGTERM', shutdown)
    process.once('SIGINT', shutdown)
    try {
      if (pair.mode === 'direct') return await serveDirectOnly(pair, stop.signal)
      let backoff = 500
      while (!stop.signal.aborted) {
        const stable = await connectOnce(pair, stop.signal)
        if (stable) backoff = 500
        if (!stop.signal.aborted)
          await delay(backoff + (Math.random() * backoff) / 4, undefined, { signal: stop.signal }).catch(() => {})
        backoff = Math.min(30000, backoff * 2)
      }
    } finally {
      unwatch()
      process.off('SIGTERM', shutdown)
      process.off('SIGINT', shutdown)
    }
  })
}
