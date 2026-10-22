import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { expect } from '@playwright/test'
import { terminalBinary } from '../integration/helpers'
import { FrameDecoder, terminalControl, terminalFrame } from '../../shared/node/terminalFrames'
import { terminalService } from '../../shared/terminalService'
import type { Checkpoint } from '../../shared/terminalState'

/** A real PTY/helper process. The tiny application prints caller-supplied bytes,
 * so tests can reproduce a TUI redraw without credentials or an agent service. */
export async function searchService() {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-search-'))
  await mkdir(join(directory, 'terminals'))
  const socketPath = `terminals/${randomUUID()}.sock`
  const child = spawn(terminalBinary, ['serve'], { cwd: directory, stdio: ['pipe', 'ignore', 'pipe'] })
  const closed = once(child, 'exit')
  let error = ''
  child.stderr.on('data', data => {
    error += data.toString()
  })
  child.stdin.end(
    JSON.stringify({
      socket: socketPath,
      command: [
        'python3',
        '-u',
        '-c',
        'import os,tty,base64\ntty.setraw(0)\nwhile True:\n line = bytearray()\n while not line.endswith(b"\\n"):\n  line.extend(os.read(0,1))\n os.write(1,base64.b64decode(line))',
      ],
      cwd: directory,
      env: { PATH: process.env.PATH, TERM: 'xterm-256color' },
      cols: 80,
      rows: 24,
    }),
  )
  const sockets: Socket[] = []
  const dispose = async () => {
    for (const socket of sockets) socket.destroy()
    child.kill('SIGTERM')
    await closed
    await rm(directory, { recursive: true, force: true })
  }
  try {
    await expect
      .poll(() => {
        if (child.exitCode !== null) throw new Error(error)
        return existsSync(join(directory, socketPath))
      })
      .toBe(true)
  } catch (failure) {
    await dispose()
    throw failure
  }
  return {
    dispose,
    async attach() {
      const socket = createConnection(join(directory, socketPath))
      sockets.push(socket)
      const decoder = new FrameDecoder()
      const parts: Checkpoint[] = []
      const output: Buffer[] = []
      let ready = false
      socket.on('data', bytes => {
        for (const frame of decoder.feed(Buffer.from(bytes))) {
          if (frame.kind === 'O') output.push(frame.payload)
          else if (frame.kind === 'C') {
            const message = JSON.parse(frame.payload.toString())
            if (message.type === 'restore') parts.push(message.checkpoint)
            if (message.type === 'ready') ready = true
          }
        }
      })
      await once(socket, 'connect')
      socket.write(terminalControl({ type: 'attach', protocol: terminalService.protocol, cols: 80, rows: 24 }))
      await expect.poll(() => ready).toBe(true)
      return {
        parts,
        disconnect: () => socket.destroy(),
        async print(text: string) {
          output.length = 0
          socket.write(terminalFrame('I', Buffer.from(Buffer.from(text).toString('base64') + '\n')))
          await expect.poll(() => Buffer.concat(output).toString()).toBe(text)
          return Buffer.concat(output).toString()
        },
      }
    },
  }
}
