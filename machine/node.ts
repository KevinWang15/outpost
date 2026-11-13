// `outpost-terminal node --socket run/node-<key>.sock`: the machine end of the
// one connection Outpost keeps to it. It runs for as long as that connection
// (stdio) is open. Drivers it starts outlive it.
import { randomUUID } from 'node:crypto'
import { createReadStream, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { connect, createServer, type Socket } from 'node:net'
import {
  machineProtocol,
  nodeMagic,
  streamWindow,
  type ChatStreamArgs,
  type FileReadArgs,
  type FileReceiveArgs,
  type ImageArgs,
  type MachineMessage,
  type RemoteError,
  type TerminalStreamArgs,
} from '../shared/machine'
import { BoundedWriter } from '../shared/node/boundedWriter'
import { FrameDecoder, terminalControl, terminalFrame } from '../shared/node/terminalFrames'
import { chatHost } from '../shared/chatHost'
import { terminalService, terminalSize } from '../shared/terminalService'
import { driverStatus, request } from './drivers'
import { checkImage, listFiles, readFile, removeFile, saveImage, StoredFile } from './files'
import { catalog, readBatch, readMessage } from './history'
import { chatSocket, startChat, startTerminal, terminalSocket } from './launch'
import { readRegistry, RegistryError, session as findSession } from './registry'
import { directories, searchConversations } from './search'
import {
  acknowledgeSession,
  createSession,
  deleteSession,
  forkSession,
  getSession,
  listSessions,
  switchSession,
  terminateSession,
  touchSession,
  updateSession,
} from './sessions'
import { socketAddress, statePath, writeJson } from './state'

function remoteError(error: unknown): RemoteError {
  if (error instanceof RegistryError) return { message: error.message, status: error.status }
  return { message: (error as Error)?.message ?? String(error), status: 500 }
}

interface Stream {
  /** Bytes from Outpost. */
  data(bytes: Buffer): void
  /** Outpost ended the stream. */
  close(): void
  /** Outpost granted more of the window. */
  credit(bytes: number): void
}

export async function serveNode(socketName: string) {
  if (!/^run\/node-[0-9a-f]{32}\.sock$/.test(socketName)) throw new Error('Invalid node socket')
  process.umask(0o077)
  const writer = new BoundedWriter(process.stdout, 256 * 1024 * 1024, 120_000, () => process.exit(1))
  const send = (message: MachineMessage) => writer.write(terminalControl(message))
  const streams = new Map<number, Stream>()
  const calls = new Map<string, { resolve(data: unknown): void; reject(error: Error): void }>()
  process.stdout.write(nodeMagic)
  send({ type: 'hello', version: terminalService.version, protocol: machineProtocol, pid: process.pid })

  // Streams --------------------------------------------------------------------------

  const header = (stream: number) => {
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32BE(stream)
    return prefix
  }
  /** Bytes to Outpost on a stream. At most a window is unacknowledged; the
   * rest waits here, and `write` returns false until it has drained. */
  const output = (stream: number) => {
    let inflight = 0
    const queue: Buffer[] = []
    let drained: (() => void) | null = null
    const flush = () => {
      while (queue.length && inflight < streamWindow && streams.has(stream)) {
        const part = queue.shift()!
        inflight += part.length
        writer.write(terminalFrame('D', Buffer.concat([header(stream), part])))
      }
      if (!queue.length && drained) {
        const resume = drained
        drained = null
        resume()
      }
    }
    return {
      write(bytes: Buffer) {
        for (let offset = 0; offset < bytes.length; offset += 64 * 1024)
          queue.push(bytes.subarray(offset, offset + 64 * 1024))
        flush()
        return queue.length === 0
      },
      drain: () => new Promise<void>(resolve => (queue.length ? (drained = resolve) : resolve())),
      credit(bytes: number) {
        inflight = Math.max(0, inflight - bytes)
        flush()
      },
    }
  }
  const closeStream = (stream: number, result: { error?: RemoteError; data?: unknown } = {}) => {
    if (!streams.delete(stream)) return
    send({ type: 'close', stream, ...result })
  }

  /** A driver's socket, carried as a stream: bytes both ways, paced by the window. */
  const pipe = (stream: number, socketPath: string, hello: Buffer) => {
    const out = output(stream)
    const socket = connect(socketAddress(socketPath))
    let ended = false
    const end = (error?: RemoteError) => {
      if (ended) return
      ended = true
      socket.destroy()
      closeStream(stream, error ? { error } : {})
    }
    socket.on('connect', () => socket.write(hello))
    socket.on('data', (bytes: Buffer) => {
      if (out.write(bytes)) return
      socket.pause()
      void out.drain().then(() => socket.resume())
    })
    socket.on('error', error =>
      end({ message: `The session’s process is not reachable: ${error.message}`, status: 502 }),
    )
    socket.on('close', () => end())
    streams.set(stream, {
      data(bytes) {
        // A stuck driver must not hold Outpost's input indefinitely.
        if (socket.writableLength > 64 * 1024 * 1024)
          return end({ message: 'The session stopped reading input.', status: 502 })
        socket.write(bytes)
      },
      close: () => {
        ended = true
        socket.end()
        streams.delete(stream)
      },
      credit: bytes => out.credit(bytes),
    })
    send({ type: 'opened', stream, data: null })
  }

  /** This node answers the session's agents from now on. */
  const bind = (session: string) => writeJson(statePath('bindings', `${session}.json`), { socket: socketName })

  const openers = {
    async terminal(stream: number, args: TerminalStreamArgs) {
      if (!terminalSize(args.cols, args.rows) || typeof args.start !== 'boolean')
        throw new RegistryError('Invalid terminal request', 400)
      const record = findSession(readRegistry(), args.session)
      const { terminal, chat } = await driverStatus(record.id)
      if (chat) throw new RegistryError('This session runs in chat. Choose Continue in a terminal to move it.')
      if (terminal && terminal.protocol !== terminalService.protocol)
        throw new RegistryError(
          'This session runs an older Outpost Terminal. Stop it, then connect again to restart it with the current one.',
        )
      if (!terminal) {
        if (!args.start)
          throw new RegistryError('The coding tool exited. Click Reconnect to start it in the same conversation.', 410)
        await startTerminal(record, args.cols, args.rows)
      }
      await touchSession(record.id)
      bind(record.id)
      pipe(
        stream,
        terminalSocket(record.id),
        terminalControl({ type: 'attach', protocol: terminalService.protocol, cols: args.cols, rows: args.rows }),
      )
    },
    async chat(stream: number, args: ChatStreamArgs) {
      const record = findSession(readRegistry(), args.session)
      const { terminal, chat } = await driverStatus(record.id)
      if (terminal) throw new RegistryError('This session runs in a terminal. Choose Continue in chat to move it.')
      if (chat && chat.protocol !== chatHost.protocol)
        throw new RegistryError('This chat runs an older Outpost Terminal. Stop the session, then open it again.')
      if (!chat) {
        if (!args.start) throw new RegistryError('This session is not running in chat.', 410)
        await startChat(record)
      }
      await touchSession(record.id)
      bind(record.id)
      pipe(stream, chatSocket(record.id), Buffer.alloc(0))
    },
    async 'file-read'(stream: number, args: FileReadArgs) {
      findSession(readRegistry(), args.session)
      const { file, path } = readFile(args.session, args.file)
      const out = output(stream)
      streams.set(stream, { data() {}, close: () => streams.delete(stream), credit: bytes => out.credit(bytes) })
      send({ type: 'opened', stream, data: file })
      try {
        for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 }))
          if (!out.write(chunk as Buffer)) await out.drain()
        closeStream(stream)
      } catch (error) {
        closeStream(stream, { error: remoteError(error) })
      }
    },
    async 'file-receive'(stream: number, args: FileReceiveArgs) {
      if (!Number.isSafeInteger(args.size) || args.size < 0) throw new RegistryError('Invalid file size', 400)
      const stored = new StoredFile(args.session, args.name, 'received')
      let received = 0
      let failed: unknown = null
      streams.set(stream, {
        data(bytes) {
          if (failed) return
          try {
            received += bytes.length
            stored.write(bytes)
            send({ type: 'credit', stream, bytes: bytes.length })
          } catch (error) {
            failed = error
          }
        },
        close() {
          streams.set(stream, { data() {}, close() {}, credit() {} })
          if (!failed && received !== args.size) failed = new RegistryError('Incomplete file upload', 400)
          if (failed) {
            stored.abort()
            return closeStream(stream, { error: remoteError(failed) })
          }
          stored.commit().then(
            file => closeStream(stream, { data: file }),
            error => closeStream(stream, { error: remoteError(error) }),
          )
        },
        credit() {},
      })
      send({ type: 'opened', stream, data: null })
    },
    async image(stream: number, args: ImageArgs) {
      checkImage(args.session, args.extension, args.size)
      const parts: Buffer[] = []
      let received = 0
      streams.set(stream, {
        data(bytes) {
          received += bytes.length
          if (received <= args.size) parts.push(bytes)
          send({ type: 'credit', stream, bytes: bytes.length })
        },
        close() {
          streams.set(stream, { data() {}, close() {}, credit() {} })
          if (received !== args.size)
            return closeStream(stream, { error: { message: 'Incomplete or invalid image upload.', status: 400 } })
          try {
            closeStream(stream, { data: saveImage(args.session, args.extension, Buffer.concat(parts)) })
          } catch (error) {
            closeStream(stream, { error: remoteError(error) })
          }
        },
        credit() {},
      })
      send({ type: 'opened', stream, data: null })
    },
  } as const

  // Calls -------------------------------------------------------------------------

  type Args = Record<string, unknown>
  const sessions = () => readRegistry().sessions
  const operations: Record<string, (args: Args) => unknown> = {
    'sessions.list': async () => ({ sessions: await listSessions() }),
    'sessions.get': args => getSession(args.id),
    'sessions.create': async args => {
      const created = await createSession(args.input as never, args.creationKey as string | undefined)
      bind(created.id)
      return created
    },
    'sessions.fork': async args => {
      const created = await forkSession(args.id, args.branch, args.rootDir)
      bind(created.id)
      return created
    },
    'sessions.update': args => updateSession(args.id, args.update as never),
    'sessions.switch': args => switchSession(args.id, args.conversation),
    'sessions.delete': async args => {
      await deleteSession(args.id)
      return null
    },
    'sessions.terminate': args => terminateSession(args.id),
    'sessions.acknowledge': args => acknowledgeSession(args.id, args.completionId),
    // Messages for a session running in a terminal, typed in by its terminal service.
    'sessions.deliver': async args => {
      const record = findSession(readRegistry(), args.id)
      const reply = await request<{ delivery?: unknown }>(terminalSocket(record.id), {
        type: 'deliver',
        key: args.key,
        text: args.text,
      })
      if (!reply) throw new RegistryError('The session is no longer running in a terminal.', 409)
      return reply.delivery
    },
    'sessions.deliveries': async args => {
      const record = findSession(readRegistry(), args.id)
      const reply = await request<{ deliveries?: unknown }>(terminalSocket(record.id), {
        type: 'deliveries',
        keys: args.keys,
      })
      if (!reply) throw new RegistryError('The session is no longer running in a terminal.', 409)
      return reply.deliveries
    },
    directories: args => directories(args.path),
    'conversations.search': args => searchConversations(args.query, args.tool, sessions()),
    'files.list': args => (findSession(readRegistry(), args.session), listFiles(String(args.session))),
    'files.remove': async args => {
      findSession(readRegistry(), args.session)
      await removeFile(String(args.session), args.file)
      return null
    },
    'history.catalog': args => catalog(sessions(), args.after ?? null, args.limit ?? 100),
    'history.read': args => readBatch(sessions(), args.sources),
    'history.message': args => readMessage(sessions(), args),
  }

  const call = (op: string, args: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = randomUUID()
      calls.set(id, { resolve, reject })
      send({ type: 'call', id, op, args })
    })

  const receive = (message: MachineMessage) => {
    switch (message.type) {
      case 'call': {
        const operation = operations[message.op]
        const args = (message.args ?? {}) as Args
        Promise.resolve()
          .then(() => {
            if (!operation) throw new RegistryError('Unknown machine operation', 400)
            return operation(args)
          })
          .then(
            data => send({ type: 'result', id: message.id, ok: true, data: data ?? null }),
            error => send({ type: 'result', id: message.id, ok: false, error: remoteError(error) }),
          )
        return
      }
      case 'result': {
        const waiter = calls.get(message.id)
        calls.delete(message.id)
        if (message.ok) waiter?.resolve(message.data)
        else waiter?.reject(new Error(message.error.message))
        return
      }
      case 'open': {
        const open = openers[message.kind] as ((stream: number, args: unknown) => Promise<void>) | undefined
        if (!open || streams.has(message.stream))
          return send({ type: 'close', stream: message.stream, error: { message: 'Invalid stream', status: 400 } })
        Promise.resolve()
          .then(() => open(message.stream, message.args ?? {}))
          .catch(error => {
            streams.delete(message.stream)
            send({ type: 'close', stream: message.stream, error: remoteError(error) })
          })
        return
      }
      case 'close':
        return streams.get(message.stream)?.close()
      case 'credit':
        return streams.get(message.stream)?.credit(message.bytes)
    }
  }

  // The local endpoint: agents' Outpost tool calls ---------------------------------

  mkdirSync(statePath('run'), { recursive: true, mode: 0o700 })
  const temporary = `${socketName}.${randomUUID().slice(0, 8)}`
  const endpoint = createServer(socket => agent(socket))
  await new Promise<void>((resolve, reject) => {
    endpoint.once('error', reject)
    endpoint.listen(socketAddress(temporary), () => resolve())
  })
  // Replace any stale endpoint atomically; a newer node of this account takes over.
  renameSync(statePath(temporary), statePath(socketName))
  const endpointInode = statSync(statePath(socketName)).ino
  const pendingAgents = new Set<Socket>()

  function agent(socket: Socket) {
    if (pendingAgents.size >= 32) return socket.destroy()
    pendingAgents.add(socket)
    socket.on('close', () => pendingAgents.delete(socket))
    socket.on('error', () => {})
    let data = ''
    socket.setEncoding('utf8')
    socket.setTimeout(90_000, () => socket.destroy())
    socket.on('data', (chunk: string) => {
      data += chunk
      if (data.length > 65536) return socket.destroy()
      const newline = data.indexOf('\n')
      if (newline < 0) return
      socket.removeAllListeners('data')
      const answer = (result: object) => socket.end(`${JSON.stringify(result)}\n`)
      let request: { session?: unknown; tool?: unknown; arguments?: unknown }
      try {
        request = JSON.parse(data.slice(0, newline))
      } catch {
        return answer({ ok: false, message: 'Invalid Outpost tool call.' })
      }
      const session = request.session
      // Only sessions bound to this node, by the launcher, can call through it.
      let bound: { socket?: string } | null
      try {
        bound = JSON.parse(readFileSync(statePath('bindings', `${String(session)}.json`), 'utf8'))
      } catch {
        bound = null
      }
      if (typeof session !== 'string' || bound?.socket !== socketName || typeof request.tool !== 'string')
        return answer({ ok: false, message: 'Reconnect this session in Outpost to use Outpost’s tools.' })
      call('agent', { session, tool: request.tool, arguments: request.arguments ?? {} }).then(
        result => answer({ ok: true, data: result }),
        error => answer({ ok: false, message: (error as Error).message }),
      )
    })
  }

  // The connection -------------------------------------------------------------------

  const decoder = new FrameDecoder()
  process.stdin.on('data', (bytes: Buffer) => {
    let frames
    try {
      frames = decoder.feed(bytes)
    } catch {
      return process.exit(1)
    }
    for (const frame of frames) {
      if (frame.kind === 'C') receive(JSON.parse(frame.payload.toString('utf8')))
      else if (frame.kind === 'D')
        streams.get(frame.payload.readUInt32BE(0))?.data(Buffer.from(frame.payload.subarray(4)))
    }
  })
  // Outpost disconnected: end this node. Sessions keep running.
  const shutdown = () => {
    endpoint.close()
    try {
      // Remove the endpoint only if a newer node has not replaced it.
      if (statSync(statePath(socketName)).ino === endpointInode) rmSync(statePath(socketName), { force: true })
    } catch {
      /* Already gone. */
    }
    process.exit(0)
  }
  process.stdin.on('end', shutdown)
  process.on('SIGHUP', shutdown)
  process.on('SIGTERM', shutdown)
}
