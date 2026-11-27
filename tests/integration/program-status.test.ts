// End-to-end OSC 7501 Program Status Protocol over a real `outpost-terminal serve` PTY:
// query replies arrive before DA1, reports drive structured `activity` frames,
// child records stay isolated, and no 7501 escape sequences leak to viewers.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SessionActivity } from '../../shared/activity'
import { FrameDecoder, terminalControl } from '../../shared/node/terminalFrames'
import { formatProgramStatusReply, formatProgramStatusReport } from '../../shared/programStatus'
import { terminalService } from '../../shared/terminalService'
import { terminalBinary } from './helpers'

const until = async (check: () => Promise<boolean> | boolean, label: string, timeout = 15_000) => {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

test(
  'outpost-terminal serve answers OSC 7501 queries before DA1 and streams validated status updates',
  { timeout: 30_000, skip: process.platform !== 'linux' },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'outpost-osc7501-'))
    const state = join(directory, '.outpost')
    await mkdir(join(state, 'terminals'), { recursive: true })
    const session = randomUUID()
    const conversation = randomUUID()
    const now = new Date().toISOString()
    await writeFile(
      join(state, 'registry.json'),
      JSON.stringify({
        version: 4,
        creations: {},
        sessions: [
          {
            id: session,
            name: 'OSC7501',
            tool: 'claude',
            rootDir: directory,
            createdAt: now,
            lastConnectedAt: null,
            storage: { CLAUDE_CONFIG_DIR: join(directory, '.claude') },
            delivery: 'auto',
            config: { revision: 1, instructions: null, model: null, mode: null, mcpServers: {}, args: '', env: {} },
            conversation,
            conversations: [{ id: conversation, tool: 'claude', startedAt: now, movedTo: null }],
          },
        ],
      }),
    )

    const replyFile = join(directory, 'replies.bin')
    const workingSeq = formatProgramStatusReport({
      state: 'working',
      app: 'claude-code',
      progress: 42,
      msg: 'Building crate',
    })
    const blockedSeq = formatProgramStatusReport({
      state: 'blocked',
      app: 'claude-code',
      kind: 'permission',
      title: 'Bash',
      msg: 'Allow cargo test?',
    })
    const childDoneSeq = formatProgramStatusReport({
      state: 'done',
      id: 'sub/1',
      app: 'claude-code',
    })
    const doneSeq = formatProgramStatusReport({
      state: 'done',
      app: 'claude-code',
      msg: 'Ready 安全',
    })

    // A tiny PTY program that probes OSC 7501 + DA1 in one write, records the
    // terminal's replies, then emits a full OSC 7501 status sequence.
    const script = [
      'import os, select, sys, termios, time, tty',
      'from pathlib import Path',
      'tty.setraw(0)',
      'os.write(1, b"\\x1b]7501;?\\x1b\\\\\\x1b[c")',
      'buf = bytearray()',
      'deadline = time.monotonic() + 5.0',
      'while time.monotonic() < deadline:',
      '  if select.select([0], [], [], 0.05)[0]:',
      '    buf.extend(os.read(0, 4096))',
      '    if b"\\x1b[?" in buf and b"c" in buf[buf.index(b"\\x1b[?"):]:',
      '      break',
      `Path(${JSON.stringify(replyFile)}).write_bytes(bytes(buf))`,
      `os.write(1, ${JSON.stringify('VISIBLE_START' + workingSeq)}.encode())`,
      'time.sleep(0.15)',
      `os.write(1, ${JSON.stringify(blockedSeq + childDoneSeq)}.encode())`,
      'time.sleep(0.15)',
      `os.write(1, ${JSON.stringify(doneSeq + 'VISIBLE_END')}.encode())`,
      'while True:',
      '  time.sleep(0.2)',
    ].join('\n')

    const socketPath = `terminals/${session}.sock`
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OUTPOST_')))
    const child = spawn(terminalBinary, ['serve'], {
      env: { ...env, HOME: directory },
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })
    const exited = once(child, 'exit')
    t.after(async () => {
      child.kill('SIGTERM')
      await exited
      await rm(directory, { recursive: true, force: true })
    })

    child.stdin.end(
      JSON.stringify({
        socket: socketPath,
        session,
        revision: 1,
        conversation,
        command: ['python3', '-u', '-c', script],
        cwd: directory,
        env: { PATH: process.env.PATH, TERM: 'xterm-256color' },
        cols: 80,
        rows: 24,
      }),
    )

    await until(() => {
      if (child.exitCode !== null) throw new Error(`serve exited early: ${stderr}`)
      return existsSync(join(state, socketPath))
    }, 'terminal socket')

    const viewer = createConnection(join(state, socketPath))
    t.after(() => viewer.destroy())
    const decoder = new FrameDecoder()
    const activities: SessionActivity[] = []
    let output = ''
    viewer.on('data', bytes => {
      for (const frame of decoder.feed(Buffer.from(bytes))) {
        if (frame.kind === 'O') output += frame.payload.toString('utf8')
        else if (frame.kind === 'C') {
          const message = JSON.parse(frame.payload.toString('utf8'))
          if (message.type === 'activity') activities.push(message.activity)
        }
      }
    })
    await once(viewer, 'connect')
    viewer.write(terminalControl({ type: 'attach', protocol: terminalService.protocol, cols: 80, rows: 24 }))

    await until(() => existsSync(replyFile), 'OSC 7501 + DA1 replies')
    const replyBytes = (await readFile(replyFile)).toString('utf8')
    const expectedReply = formatProgramStatusReply('st')
    const statusIdx = replyBytes.indexOf(expectedReply)
    const da1Idx = replyBytes.indexOf('\x1b[?')
    assert.ok(statusIdx >= 0, `expected OSC 7501 query reply in ${JSON.stringify(replyBytes)}`)
    assert.ok(da1Idx >= 0, `expected DA1 reply in ${JSON.stringify(replyBytes)}`)
    assert.ok(statusIdx < da1Idx, `OSC 7501 reply must precede DA1: ${JSON.stringify(replyBytes)}`)

    await until(() => activities.some(item => item.state === 'finished'), 'finished activity')
    const final = activities.at(-1)!
    assert.equal(final.state, 'finished')
    assert.equal(final.detail, 'Ready 安全')
    assert.ok(final.completionId)

    const waiting = activities.find(item => item.state === 'waiting')
    assert.ok(waiting, `expected waiting activity in ${JSON.stringify(activities)}`)
    assert.equal(waiting.blockedKind, 'permission')
    assert.equal(waiting.detail, 'Bash: Allow cargo test?')

    const working = activities.find(item => item.state === 'working')
    assert.ok(working, `expected working activity in ${JSON.stringify(activities)}`)
    assert.equal(working.progress, 42)
    assert.equal(working.detail, 'Building crate')

    assert.ok(!output.includes('7501;'), `OSC 7501 must be stripped from viewer output: ${JSON.stringify(output)}`)
  },
)
