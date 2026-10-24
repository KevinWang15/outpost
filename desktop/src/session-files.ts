import { createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dialog, type BrowserWindow, type WebContents } from 'electron'
import { parseSessionFile, sessionFileId, type SessionFile } from '../../shared/sessionFiles'
import { SessionFileCache } from '../../shared/sessionFileCache'
import {
  fileRequest,
  listSessionFiles,
  sessionFileBlob,
  type SessionFileAuthorization,
} from '../../shared/sessionFileRequests'

/** Bound to a pane's authenticated session, shared by its list, viewer and saves. */
export class NativeSessionFiles {
  private controller = new AbortController()
  private cache: SessionFileCache
  private listing: Promise<SessionFile[]> | null = null
  private revision = 0
  private saving = false
  constructor(private authorization: () => SessionFileAuthorization) {
    this.cache = new SessionFileCache((file, signal) => sessionFileBlob(this.authorization(), file, signal))
  }
  list() {
    this.controller.signal.throwIfAborted()
    if (!this.listing) {
      const read = async () => {
        const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(20_000)])
        for (;;) {
          const revision = this.revision
          const files = await listSessionFiles(this.authorization(), signal)
          if (revision !== this.revision) continue
          this.cache.retain(files)
          return files
        }
      }
      this.listing = read().finally(() => {
        this.listing = null
      })
    }
    return this.listing
  }
  read(value: unknown) {
    this.controller.signal.throwIfAborted()
    return this.cache.read(parseSessionFile(value))
  }
  async remove(id: unknown) {
    if (!sessionFileId(id)) throw new Error('Invalid session file ID.')
    await fileRequest(
      this.authorization(),
      '/' + id,
      AbortSignal.any([this.controller.signal, AbortSignal.timeout(120_000)]),
      'DELETE',
    )
    this.revision++
    this.cache.remove(id)
  }
  async save(window: BrowserWindow, contents: WebContents, value: unknown) {
    if (this.saving) return false
    this.saving = true
    try {
      return await saveSessionFile(window, contents, file => this.read(file), value)
    } finally {
      this.saving = false
    }
  }
  dispose() {
    this.controller.abort()
    this.cache.clear()
  }
}

/** Only a pane's own authenticated attachment can reach a user-selected save path. */
async function saveSessionFile(
  window: BrowserWindow,
  contents: WebContents,
  read: (file: SessionFile) => Promise<Blob>,
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
    const blob = await read(file)
    signal.throwIfAborted()
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
      Readable.fromWeb(blob.stream() as Parameters<typeof Readable.fromWeb>[0]),
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
