// Automatic image-paste fallback on terminals and ACP chat terminals.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chatHost } from '../../shared/chatHost'
import { FrameDecoder, terminalControl } from '../../shared/node/terminalFrames'
import { terminalFileChunk, type ImagePasteMode } from '../../shared/terminalFiles'
import { ChatTerminal, pasteChatImage } from '../../machine/chatTerminal'
import { harness } from '../../machine/harnesses'
import { chatSocket, socketAddress, statePath } from '../../machine/state'
import { clipboardOsc52 } from '../../machine/clipboardOsc52'
import { pasteTerminalImage, TerminalFileRequests, type TerminalClipboard } from '../../machine/terminalFileRequests'
import type { TerminalImage } from '../../machine/terminalImages'
import { machine, record, register, uuid } from './fixtures'

const png = readFileSync(fileURLToPath(new URL('../../public/favicon-32x32.png', import.meta.url)))

function uploadAndPaste(files: TerminalFileRequests, bytes: Buffer, mode: ImagePasteMode, id = 'paste-1') {
  const transfer = 'transfer-' + id
  for (let offset = 0; offset < bytes.length; offset += terminalFileChunk) {
    const chunk = bytes.subarray(offset, offset + terminalFileChunk)
    files.handle({
      type: 'image-write',
      id: `write-${id}-${offset}`,
      transfer,
      mime: 'image/png',
      size: bytes.length,
      offset,
      chunk: chunk.toString('base64'),
    })
  }
  files.handle({ type: 'image-paste', id, transfer, mode })
}

async function waitForResult(messages: Record<string, unknown>[], id: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const match = messages.find(m => m.type === 'result' && m.id === id)
    if (match) return match
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for result ${id}`)
}

test('pasteTerminalImage prefers clipboard when available and falls back to file path automatically', async () => {
  const sent: string[] = []
  const paths: TerminalImage[] = []
  const working: TerminalClipboard = {
    async paste(_image, _signal, sendKey) {
      sendKey()
      return true
    },
  }
  const messages: Record<string, unknown>[] = []
  let activeClipboard: TerminalClipboard | null = working
  let exited = false
  let held = false
  const files = new TerminalFileRequests(
    'session-1',
    message => messages.push(message as Record<string, unknown>),
    () => {},
    (item, mode, signal) =>
      pasteTerminalImage(item, mode, signal, {
        exited: () => exited,
        held: () => held,
        clipboard: activeClipboard,
        sendKey: () => sent.push('ctrl-v'),
        pastePath: pasted => paths.push(pasted),
      }),
  )

  // Dedicated clipboard works -> attachment mode, no file path written.
  uploadAndPaste(files, png, 'attachment', 'ok-clipboard')
  assert.deepEqual(await waitForResult(messages, 'ok-clipboard'), {
    type: 'result',
    id: 'ok-clipboard',
    ok: true,
    mode: 'attachment',
  })
  assert.deepEqual(sent, ['ctrl-v'])
  assert.equal(paths.length, 0)

  // Explicit file path mode skips clipboard even when available.
  uploadAndPaste(files, png, 'path', 'explicit-path')
  assert.deepEqual(await waitForResult(messages, 'explicit-path'), {
    type: 'result',
    id: 'explicit-path',
    ok: true,
    mode: 'path',
  })
  assert.equal(sent.length, 1)
  assert.equal(paths.length, 1)

  // Tool without clipboard shortcut or machine without Xvfb/GTK -> instant path fallback.
  activeClipboard = null
  uploadAndPaste(files, png, 'attachment', 'no-clipboard')
  assert.deepEqual(await waitForResult(messages, 'no-clipboard'), {
    type: 'result',
    id: 'no-clipboard',
    ok: true,
    mode: 'path',
  })
  assert.equal(paths.length, 2)

  // Clipboard helper unable to deliver (helper died / timed out) -> automatic path fallback.
  activeClipboard = {
    async paste() {
      return false
    },
  }
  uploadAndPaste(files, png, 'attachment', 'clipboard-declined')
  assert.deepEqual(await waitForResult(messages, 'clipboard-declined'), {
    type: 'result',
    id: 'clipboard-declined',
    ok: true,
    mode: 'path',
  })
  assert.equal(paths.length, 3)

  // Operational errors (delivery in flight, exited tool, busy clipboard) do not fall back to path.
  activeClipboard = working
  held = true
  uploadAndPaste(files, png, 'attachment', 'held-error')
  const heldResult = await waitForResult(messages, 'held-error')
  assert.equal(heldResult.ok, false)
  assert.match(String(heldResult.message), /receiving a message/)
  assert.equal(paths.length, 3)
  held = false

  activeClipboard = {
    async paste() {
      throw new Error('The agent is still reading the previous image.')
    },
  }
  uploadAndPaste(files, png, 'attachment', 'busy-error')
  const busyResult = await waitForResult(messages, 'busy-error')
  assert.equal(busyResult.ok, false)
  assert.match(String(busyResult.message), /previous image/)
  assert.equal(paths.length, 3)

  exited = true
  uploadAndPaste(files, png, 'attachment', 'exited-error')
  const exitedResult = await waitForResult(messages, 'exited-error')
  assert.equal(exitedResult.ok, false)
  assert.match(String(exitedResult.message), /coding tool exited/)
  assert.equal(paths.length, 3)

  files.close()
})

async function startChatTerminal(t: TestContext, imagesEnabled: boolean) {
  const home = machine(t)
  mkdirSync(statePath('chats'), { recursive: true })
  process.chdir(statePath())
  const session = record(home, 'claude', uuid, {
    rootDir: '/workspace',
    storage: harness('claude').storage('/workspace/claude'),
  })
  await register(session)
  const socketPath = socketAddress(chatSocket(session.id))
  const server = createServer(peer => {
    const decoder = new FrameDecoder()
    peer.on('data', bytes => {
      for (const frame of decoder.feed(Buffer.from(bytes))) {
        if (frame.kind !== 'C') continue
        const msg = JSON.parse(frame.payload.toString())
        if (msg.type === 'hello') {
          peer.write(
            terminalControl({
              type: 'welcome',
              info: {
                activity: {
                  state: 'idle',
                  blockedKind: null,
                  progress: null,
                  completionId: null,
                  observation: 'current',
                  detail: null,
                  observedAt: null,
                  updatedAt: null,
                },
                images: imagesEnabled,
                models: [],
                model: null,
                modes: [],
                mode: null,
              },
              journal: { entries: [] },
            }),
          )
        }
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => resolve())
  })
  const view = new ChatTerminal(session.id, 100, 24)
  const decoder = new FrameDecoder()
  const controls: Record<string, unknown>[] = []
  let output = ''
  view.on('data', chunk => {
    for (const frame of decoder.feed(Buffer.from(chunk))) {
      if (frame.kind === 'C') controls.push(JSON.parse(frame.payload.toString()))
      if (frame.kind === 'O') output += frame.payload.toString()
    }
  })
  t.after(() => {
    view.destroy()
    server.close()
  })
  const deadline = Date.now() + 5000
  while (!controls.some(m => m.type === 'ready')) {
    if (Date.now() > deadline) throw new Error('ChatTerminal did not become ready')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const paste = async (bytes: Buffer, mode: ImagePasteMode, id: string) => {
    const transfer = 'chat-' + id
    for (let offset = 0; offset < bytes.length; offset += terminalFileChunk) {
      const chunk = bytes.subarray(offset, offset + terminalFileChunk)
      view.write(
        terminalControl({
          type: 'image-write',
          id: `write-${id}-${offset}`,
          transfer,
          mime: 'image/png',
          size: bytes.length,
          offset,
          chunk: chunk.toString('base64'),
        }),
      )
    }
    view.write(terminalControl({ type: 'image-paste', id, transfer, mode }))
    return waitForResult(controls, id)
  }
  return { home, session, paste, output: () => output }
}

test('pasteChatImage attaches inline when supported and falls back to file path otherwise', async () => {
  let imagesEnabled = false
  let draftCount = 0
  let attached = 0
  let pastedPaths = 0
  const messages: Record<string, unknown>[] = []
  const files = new TerminalFileRequests(
    'session-chat',
    message => messages.push(message as Record<string, unknown>),
    () => {},
    (item, mode) =>
      pasteChatImage(item, mode, {
        imagesEnabled,
        draftCount,
        attach: () => {
          attached++
          draftCount++
        },
        pastePath: () => {
          pastedPaths++
        },
      }),
  )

  // Agent without image capability -> automatic file path fallback.
  uploadAndPaste(files, png, 'attachment', 'chat-no-images')
  assert.deepEqual(await waitForResult(messages, 'chat-no-images'), {
    type: 'result',
    id: 'chat-no-images',
    ok: true,
    mode: 'path',
  })
  assert.equal(attached, 0)
  assert.equal(pastedPaths, 1)

  // Agent with image capability & image <= 5 MiB -> inline draft attachment.
  imagesEnabled = true
  uploadAndPaste(files, png, 'attachment', 'chat-inline')
  assert.deepEqual(await waitForResult(messages, 'chat-inline'), {
    type: 'result',
    id: 'chat-inline',
    ok: true,
    mode: 'attachment',
  })
  assert.equal(attached, 1)
  assert.equal(pastedPaths, 1)

  // Explicit path mode skips inline attachment even when supported.
  uploadAndPaste(files, png, 'path', 'chat-explicit-path')
  assert.deepEqual(await waitForResult(messages, 'chat-explicit-path'), {
    type: 'result',
    id: 'chat-explicit-path',
    ok: true,
    mode: 'path',
  })
  assert.equal(attached, 1)
  assert.equal(pastedPaths, 2)

  // Image larger than 5 MiB -> automatic file path fallback.
  const oversized = Buffer.alloc(chatHost.maxImageBytes + 1024, 0x7a)
  png.copy(oversized)
  uploadAndPaste(files, oversized, 'attachment', 'chat-oversized')
  assert.deepEqual(await waitForResult(messages, 'chat-oversized'), {
    type: 'result',
    id: 'chat-oversized',
    ok: true,
    mode: 'path',
  })
  assert.equal(attached, 1)
  assert.equal(pastedPaths, 3)

  // Prompt draft limit still errors cleanly instead of silently mixing modes.
  draftCount = chatHost.maxFiles
  uploadAndPaste(files, png, 'attachment', 'chat-limit')
  const limitResult = await waitForResult(messages, 'chat-limit')
  assert.equal(limitResult.ok, false)
  assert.match(String(limitResult.message), /Attach at most/)
  assert.equal(pastedPaths, 3)

  files.close()
})

test(
  'ChatTerminal attaches inline images when supported and automatically falls back to file path otherwise',
  { skip: process.platform === 'win32' && 'Unix domain sockets require POSIX' },
  async t => {
    const previousCwd = process.cwd()
    t.after(() => process.chdir(previousCwd))
    // Agent without image support -> automatic file path fallback.
    const withoutImages = await startChatTerminal(t, false)
    assert.deepEqual(await withoutImages.paste(png, 'attachment', 'no-images'), {
      type: 'result',
      id: 'no-images',
      ok: true,
      mode: 'path',
    })
    const noImagePath = withoutImages.output().match(/([^\r\n\s]+clipboard[^\r\n\s]+\.png)/)?.[1]
    assert.ok(noImagePath, 'expected saved image path in terminal output')
    assert.deepEqual(readFileSync(noImagePath), png)

    // Agent with image support -> inline draft attachment for <= 5 MiB, automatic file path for > 5 MiB.
    const withImages = await startChatTerminal(t, true)
    assert.deepEqual(await withImages.paste(png, 'attachment', 'inline'), {
      type: 'result',
      id: 'inline',
      ok: true,
      mode: 'attachment',
    })
    assert.match(withImages.output(), /\[Image 1\]/)

    const oversized = Buffer.alloc(chatHost.maxImageBytes + 1024, 0x7a)
    png.copy(oversized)
    assert.deepEqual(await withImages.paste(oversized, 'attachment', 'oversized'), {
      type: 'result',
      id: 'oversized',
      ok: true,
      mode: 'path',
    })
    const oversizedPath = withImages.output().match(/([^\r\n\s]+clipboard[^\r\n\s]+\.png)/)?.[1]
    assert.ok(oversizedPath, 'expected saved oversized image path in terminal output')
    assert.deepEqual(readFileSync(oversizedPath), oversized)
    assert.ok(oversizedPath.startsWith(join(withImages.home, '.outpost', 'clipboard', withImages.session.id)))
  },
)

test('clipboardOsc52 validates and wraps base64 clipboard payloads for OSC 52 forwarding', () => {
  const hello = Buffer.from('hello from codex 你好\n', 'utf8').toString('base64')
  assert.equal(clipboardOsc52(hello)?.toString('ascii'), `\x1b]52;c;${hello}\x07`)

  // Boundary: exact 1 MiB raw payload is accepted; 1 MiB + 1 byte is rejected.
  const exactLimit = Buffer.alloc(1024 * 1024, 0x61).toString('base64')
  assert.equal(clipboardOsc52(exactLimit)?.length, `\x1b]52;c;${exactLimit}\x07`.length)
  const overLimit = Buffer.alloc(1024 * 1024 + 1, 0x61).toString('base64')
  assert.equal(clipboardOsc52(overLimit), null)

  // Reject empty, non-string, malformed base64, and control-character injection attempts.
  assert.equal(clipboardOsc52(''), null)
  assert.equal(clipboardOsc52(null), null)
  assert.equal(clipboardOsc52(123), null)
  assert.equal(clipboardOsc52('abc'), null)
  assert.equal(clipboardOsc52('===='), null)
  assert.equal(clipboardOsc52('aGVs\x07\x1b[2J'), null)
  assert.equal(clipboardOsc52('aGVs;bG8='), null)
  assert.equal(clipboardOsc52('?'), null)
})
