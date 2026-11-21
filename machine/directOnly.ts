// Direct-only installations have no network dialer. The client's requests carry
// short-lived, single-use permissions from the installed server's signing key.
import { createServer, type IncomingMessage } from 'node:http'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { directApiPath, directTerminalPath } from '../shared/directOnly'
import { DirectTickets } from '../shared/node/directTickets'
import { Connection } from '../shared/node/terminalViewer'
import { requiredSoftware, type SessionInput, type SessionUpdate } from '../shared/model'
import { type HarnessId } from '../shared/harnesses'
import { sessionCreationOptions } from '../shared/sessionCreation'
import { inspectionScript } from '../shared/node/softwareInspection'
import { desktopSession } from '../shared/desktopSession'
import { softwareReport } from '../backend/software'
import { launchSize } from '../backend/sessions'
import { runCommand } from '../backend/process'
import { loginScriptShell } from '../backend/shell'
import { terminalStream } from './direct'
import { prepareTerminal } from './terminalAttach'
import * as sessions from './sessions'
import { directories, searchConversations } from './search'
import { readRegistry, RegistryError } from './registry'
import { socketAddress } from './state'
import type { DirectInstall } from './installation'

type Call = {
  op: string
  desktop: boolean
  tools: HarnessId[]
  name: string
  sessionId?: string
  creationKey?: string
  input?: unknown
  query: { path?: string }
}
async function execute(call: Call, targetId: string) {
  const target = { id: targetId, name: call.name, tools: call.tools }
  const id = call.sessionId
  switch (call.op) {
    case 'list': {
      const list = await sessions.listSessions()
      return call.desktop ? list.map(s => desktopSession(s, target)) : { sessions: list }
    }
    case 'get':
      return sessions.getSession(id)
    case 'create': {
      const input = call.input as SessionInput
      launchSize(input)
      if (!call.tools.includes(input.tool)) throw Error('Tool unavailable on this machine.')
      const s = await sessions.createSession(input, call.creationKey)
      return call.desktop ? desktopSession(s, target) : s
    }
    case 'fork': {
      const { branch, rootDir } = call.input as { branch: string; rootDir: string }
      if (!call.tools.includes((await sessions.getSession(id)).tool)) throw Error('Tool unavailable on this machine.')
      return sessions.forkSession(id, branch, rootDir)
    }
    case 'update': {
      const patch = call.input as SessionUpdate
      launchSize(patch)
      return sessions.updateSession(id, patch)
    }
    case 'delete':
      await sessions.deleteSession(id)
      return null
    case 'switch':
      return sessions.switchSession(id, (call.input as { conversation: string }).conversation)
    case 'terminate':
      return sessions.terminateSession(id)
    case 'acknowledge':
      return sessions.acknowledgeSession(id, (call.input as { completionId: string }).completionId)
    case 'directories':
      return directories(call.query.path)
    case 'search': {
      const input = call.input as { query: string; tool?: HarnessId }
      return searchConversations(input.query, input.tool, readRegistry().sessions)
    }
    case 'options':
    case 'software': {
      const ids = requiredSoftware(target),
        marker = 'OUTPOST_SOFTWARE_' + randomUUID()
      const result = await runCommand(
        { executable: 'sh', args: ['-c', loginScriptShell('interactive')], label: 'Software inspection' },
        inspectionScript(ids, marker),
        { timeoutMs: 45000 },
      )
      const report = softwareReport(ids, marker, result)
      return call.op === 'software'
        ? { ...report, installation: null }
        : sessionCreationOptions(target, report.software)
    }
    default:
      throw Error('Unknown direct operation.')
  }
}
async function readTicket(req: IncomingMessage) {
  const parts: Buffer[] = []
  let size = 0
  for await (const part of req) {
    size += part.length
    if (size > 512 * 1024) throw Error('Request too large.')
    parts.push(part)
  }
  return JSON.parse(Buffer.concat(parts).toString()).ticket
}
type Attach = { lease: string; session: string; name: string; cols: number; rows: number; start: boolean }
export async function serveDirectOnly(config: DirectInstall, signal: AbortSignal) {
  const tickets = new DirectTickets(config.publicKey, config.targetId)
  const port = Number(process.env.OUTPOST_DIRECT_PORT ?? 8844)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid OUTPOST_DIRECT_PORT.')
  const pending = new Set<Promise<unknown>>()
  async function track<T>(work: Promise<T>) {
    pending.add(work)
    try {
      return await work
    } finally {
      pending.delete(work)
    }
  }
  const server = createServer(async (req, res) => {
    const end = (code: number, value: unknown) => {
      if (res.destroyed) return
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    if (req.url !== directApiPath) return end(404, { message: 'Unknown route.' })
    if (req.headers.origin && req.headers.origin !== config.origin)
      return end(403, { message: 'Incorrect Outpost origin.' })
    res.setHeader('Access-Control-Allow-Origin', config.origin)
    res.setHeader('Vary', 'Origin')
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Private-Network': 'true',
      })
      return res.end()
    }
    if (req.method !== 'POST') return end(405, { message: 'Expected POST.' })
    let call: Call
    try {
      call = tickets.redeem<Call>(await readTicket(req), 'request').data
    } catch {
      return end(403, { message: 'Invalid direct request authorization.' })
    }
    try {
      if (signal.aborted) return end(503, { message: 'Machine is disconnecting.' })
      return end(200, await track(execute(call, config.targetId)))
    } catch (e) {
      return end(e instanceof RegistryError ? e.status : 400, { message: (e as Error).message })
    }
  })
  server.requestTimeout = 10000
  const peers = new WebSocketServer({
    server,
    path: directTerminalPath,
    perMessageDeflate: false,
    maxPayload: 512 * 1024,
  })
  peers.on('connection', (ws, req) => {
    ws.on('error', () => ws.terminate())
    if (req.headers.origin !== config.origin || peers.clients.size > 64) return ws.close(1008, 'Connection rejected')
    let timeout = setTimeout(() => ws.terminate(), 5000)
    ws.once('close', () => clearTimeout(timeout))
    ws.once('message', async (raw, binary) => {
      let claim
      try {
        if (binary) throw Error()
        claim = tickets.redeem<Attach>(raw.toString(), 'attach')
      } catch {
        return ws.close(1008, 'Invalid direct attachment')
      }
      const a = claim.data
      const expires = (until: number) => {
        clearTimeout(timeout)
        timeout = setTimeout(() => ws.terminate(), Math.max(0, until - Date.now()))
      }
      expires(claim.until)
      const viewer: Connection<string> = new Connection(a.session, ws, {
        activate: () => false,
        forget: () => {},
        logged: () => {},
        filesChanged: () => viewer.send({ type: 'signal', signal: { type: 'files.changed', payload: {} } }),
        renew: ticket => {
          try {
            const r = tickets.redeem<{ lease: string }>(ticket, 'renew')
            if (r.data.lease !== a.lease) throw Error()
            expires(r.until)
          } catch {
            ws.close(1008, 'Invalid direct lease')
          }
        },
      })
      try {
        if (signal.aborted) return ws.terminate()
        const { record, path, hello } = await track(prepareTerminal(a))
        if (viewer.abort.signal.aborted) return
        viewer.send({
          type: 'hello',
          resume: '',
          target: { id: config.targetId, name: a.name },
          session: { id: record.id, name: record.name, tool: record.tool },
        })
        viewer.start(terminalStream(socketAddress(path), hello))
      } catch (e) {
        viewer.close(
          e instanceof RegistryError && [404, 410].includes(e.status) ? 'ended' : 'unavailable',
          (e as Error).message,
        )
      }
    })
  })
  try {
    server.listen(port, '127.0.0.1')
    await once(server, 'listening')
    if (!signal.aborted) await once(signal, 'abort')
  } finally {
    for (const ws of peers.clients) ws.terminate()
    peers.close()
    server.closeAllConnections()
    server.close()
    await Promise.allSettled(pending)
  }
}
