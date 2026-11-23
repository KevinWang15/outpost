import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import program from './clipboard.py' with { type: 'text' }
import type { TerminalImage } from './terminalImages'

const fallback = 'Use “Paste image as file path” for this program.'
export const unavailableClipboard = 'Native image paste needs Xvfb, xauth and Python GTK 3 on this machine. ' + fallback

/** One authenticated, local-only display per agent. Its owner exits on stdin EOF,
 * including if the worker dies. The remote workstation's clipboard is never opened. */
export async function openTerminalClipboard(env: Record<string, string>) {
  const runner = Bun.which('xvfb-run', { PATH: env.PATH })
  const python = Bun.which('python3', { PATH: '/usr/bin:/bin' })
  if (!runner || !python) return null
  const helper = spawn(runner, ['-a', '-s', '-screen 0 64x64x24 -nolisten tcp', python, '-I', '-u', '-c', program], {
    env: { ...env, GDK_BACKEND: 'x11', NO_AT_BRIDGE: '1' },
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  const lines = createInterface({ input: helper.stdout })
  let pending: { id: string; offered: () => void; finish: (error?: Error) => void } | undefined
  const startup = Promise.withResolvers<{ display: string; authority: string } | null>()
  const stop = () => {
    helper.stdin.end()
  }
  const lost = () => {
    startup.resolve(null)
    pending?.finish(new Error(unavailableClipboard))
  }
  helper.on('error', lost)
  helper.stdin.on('error', lost)
  lines.on('close', lost)
  lines.on('line', line => {
    let reply
    try {
      reply = JSON.parse(line)
    } catch {
      return
    }
    if (
      typeof reply.display === 'string' &&
      /^:[0-9]+$/.test(reply.display) &&
      typeof reply.authority === 'string' &&
      reply.authority.startsWith('/')
    ) {
      startup.resolve({ display: reply.display, authority: reply.authority })
    } else if (pending && reply.id === pending.id) {
      if (reply.state === 'offered') pending.offered()
      else if (reply.state === 'read') pending.finish()
      else if (reply.state === 'error') pending.finish(new Error(reply.message || unavailableClipboard))
    }
  })
  const timeout = setTimeout(() => startup.resolve(null), 4000)
  const display = await startup.promise
  clearTimeout(timeout)
  if (!display) {
    stop()
    return null
  }
  return {
    ...display,
    close: stop,
    async paste(image: TerminalImage, signal: AbortSignal, sendKey: () => void) {
      signal.throwIfAborted()
      if (helper.exitCode !== null || helper.stdin.destroyed || !helper.stdin.writable)
        throw new Error(unavailableClipboard)
      if (pending) throw new Error('The agent is still reading the previous image.')
      const id = randomUUID()
      const done = Promise.withResolvers<void>()
      // An abort during image decoding may settle this before we await it.
      void done.promise.catch(() => {})
      let settled = false
      let keySent = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        if (error) done.reject(error)
        else done.resolve()
      }
      const abort = () => finish(new Error('Image paste cancelled.'))
      const timer = setTimeout(
        () => finish(new Error('The program did not read the clipboard image. ' + fallback)),
        8000,
      )
      pending = {
        id,
        offered: () => {
          if (settled || keySent) return
          keySent = true
          try {
            signal.throwIfAborted()
            sendKey()
          } catch (error) {
            finish(error as Error)
          }
        },
        finish,
      }
      signal.addEventListener('abort', abort, { once: true })
      try {
        // Keep animated GIFs to their first frame. WebP is an optional GTK plugin;
        // Bun embeds that decoder in the machine executable.
        if (image.mime === 'image/webp' || image.mime === 'image/gif') {
          const png = await new Bun.Image(image.bytes, { maxPixels: 32 * 1024 * 1024 }).png().bytes()
          image = { mime: 'image/png', bytes: Buffer.from(png.buffer, png.byteOffset, png.byteLength) }
        }
        if (settled) return await done.promise
        signal.throwIfAborted()
        helper.stdin.write(id + ' ' + image.mime + ' ' + image.bytes.length + '\n')
        helper.stdin.write(image.bytes)
        await done.promise
      } catch (error) {
        if (helper.stdin.writable) helper.stdin.write(id + ' clear 0\n')
        throw error
      } finally {
        pending = undefined
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
      }
    },
  }
}
