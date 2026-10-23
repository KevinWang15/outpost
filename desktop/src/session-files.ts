import { createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dialog, type BrowserWindow, type WebContents } from 'electron'
import { parseSessionFile } from '../../shared/sessionFiles'

/** Only a pane's own authenticated attachment can reach a user-selected save path. */
export async function saveSessionFile(
  window: BrowserWindow,
  contents: WebContents,
  origin: string,
  token: string,
  value: unknown,
) {
  const file = parseSessionFile(value)
  const controller = new AbortController()
  const abort = () => controller.abort()
  contents.once('destroyed', abort)
  let temporary: string | undefined
  try {
    const selected = await dialog.showSaveDialog(window, { title: 'Save session file', defaultPath: file.name })
    if (selected.canceled || !selected.filePath || contents.isDestroyed()) return false
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
    const response = await fetch(new URL(`/api/terminal/files/${file.id}`, origin), {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal,
    })
    if (!response.ok || !response.body) throw new Error(`Could not download the file (${response.status}).`)
    temporary = join(
      dirname(selected.filePath),
      '.' + basename(selected.filePath).slice(0, 80) + '.' + randomUUID() + '.part',
    )
    let received = 0
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length
        done(received > file.size ? new Error('File exceeds its declared size.') : null, chunk)
      },
    })
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      limit,
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
      { signal },
    )
    if (received !== file.size) throw new Error('File download was incomplete. Try again.')
    await rename(temporary, selected.filePath)
    return true
  } finally {
    contents.removeListener('destroyed', abort)
    if (temporary) await rm(temporary, { force: true }).catch(() => {})
  }
}
