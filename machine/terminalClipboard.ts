import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import program from './clipboard.py' with { type: 'text' }
import type { TerminalImage } from './terminalImages'

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
  let pending: { id: string; offered: () => void; finish: (outcome: boolean | Error) => void } | undefined
  const startup = Promise.withResolvers<{ display: string; authority: string } | null>()
  const stop = () => {
    helper.stdin.end()
  }
  const lost = () => {
    startup.resolve(null)
    pending?.finish(false)
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
      else if (reply.state === 'read') pending.finish(true)
      else if (reply.state === 'error') pending.finish(false)
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
    /** Offer the image on the session clipboard and return whether the tool read it.
     * Returning false lets the caller fall back to saving and pasting a file path. */
    async paste(image: TerminalImage, signal: AbortSignal, sendKey: () => void): Promise<boolean> {
      signal.throwIfAborted()
      if (pending) throw new Error('The agent is still reading the previous image.')
      if (helper.exitCode !== null || helper.stdin.destroyed || !helper.stdin.writable) return false
      const id = randomUUID()
      const done = Promise.withResolvers<boolean>()
      // An abort during image decoding may settle this before we await it.
      void done.promise.catch(() => {})
      let settled = false
      let keySent = false
      let written = false
      const finish = (outcome: boolean | Error) => {
        if (settled) return
        settled = true
        if (outcome instanceof Error) done.reject(outcome)
        else done.resolve(outcome)
      }
      const abort = () => finish(new Error('Image paste cancelled.'))
      const timer = setTimeout(() => finish(false), 8000)
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
      let delivered = false
      try {
        // Keep animated GIFs to their first frame. WebP is an optional GTK plugin;
        // Bun embeds that decoder in the machine executable.
        if (image.mime === 'image/webp' || image.mime === 'image/gif') {
          try {
            const png = await new Bun.Image(image.bytes, { maxPixels: 32 * 1024 * 1024 }).png().bytes()
            image = { mime: 'image/png', bytes: Buffer.from(png.buffer, png.byteOffset, png.byteLength) }
          } catch {
            signal.throwIfAborted()
            return false
          }
        }
        if (settled) {
          delivered = await done.promise
          return delivered
        }
        signal.throwIfAborted()
        if (helper.exitCode !== null || helper.stdin.destroyed || !helper.stdin.writable) return false
        written = true
        helper.stdin.write(id + ' ' + image.mime + ' ' + image.bytes.length + '\n')
        helper.stdin.write(image.bytes)
        delivered = await done.promise
        return delivered
      } finally {
        if (written && !delivered && !helper.stdin.destroyed && helper.stdin.writable)
          helper.stdin.write(id + ' clear 0\n')
        pending = undefined
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
      }
    },
  }
}
