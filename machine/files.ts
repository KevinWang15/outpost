// A session's files, in both directions: files its agent published and files
// sent to it in messages. Each is `<id>/metadata.json` beside
// `<id>/content/<name>`, so the agent's own tools see the real filename.
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { isAbsolute, join } from 'node:path'
import {
  maxSessionFileBytes,
  maxSessionFiles,
  parseSessionFile,
  sessionFileId,
  sessionFileName,
  sniffMediaType,
  type SessionFile,
} from '../shared/sessionFiles'
import { imageExtensions, maxImageBytes } from '../shared/images'
import { readRegistry, RegistryError, session as findSession } from './registry'
import { locked, statePath, writeFile } from './state'

const maxTotalBytes = 256 * 1024 * 1024

export const filesDirectory = (session: string) => statePath('files', session)
export const contentPath = (session: string, file: SessionFile) =>
  join(filesDirectory(session), file.id, 'content', file.name)

function syncDirectory(path: string) {
  const descriptor = openSync(path, 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

export function listFiles(session: string): SessionFile[] {
  let names: string[]
  try {
    names = readdirSync(filesDirectory(session))
  } catch {
    return []
  }
  const files: SessionFile[] = []
  for (const name of names.filter(sessionFileId))
    try {
      files.push(
        parseSessionFile(JSON.parse(readFileSync(join(filesDirectory(session), name, 'metadata.json'), 'utf8'))),
      )
    } catch {
      /* Removed concurrently; the next list reflects it. */
    }
  return files.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
}

/** A file being written; nothing appears until `commit`. */
export class StoredFile {
  private temporary: string
  private descriptor: number
  private size = 0
  private prefix = Buffer.alloc(0)
  constructor(
    private session: string,
    private name: string,
    private source: SessionFile['source'],
  ) {
    findSession(readRegistry(), session)
    if (!sessionFileName(name))
      throw new RegistryError(
        'Provide a filename without directories or control characters (240 UTF-8 bytes maximum).',
        400,
      )
    mkdirSync(filesDirectory(session), { recursive: true, mode: 0o700 })
    this.temporary = mkdtempSync(join(filesDirectory(session), '.storing-'))
    mkdirSync(join(this.temporary, 'content'), { mode: 0o700 })
    this.descriptor = openSync(join(this.temporary, 'content', name), 'wx', 0o600)
  }
  write(data: Buffer) {
    this.size += data.length
    if (this.size > maxSessionFileBytes) throw new RegistryError('Files must be at most 32 MiB.', 413)
    if (this.prefix.length < 16) this.prefix = Buffer.concat([this.prefix, data.subarray(0, 16)])
    writeSync(this.descriptor, data)
  }
  async commit(): Promise<SessionFile> {
    try {
      fsyncSync(this.descriptor)
      closeSync(this.descriptor)
      const file: SessionFile = {
        id: randomUUID().replace(/-/g, ''),
        name: this.name,
        size: this.size,
        createdAt: new Date().toISOString(),
        mediaType: sniffMediaType(this.prefix),
        source: this.source,
      }
      writeFileSync(join(this.temporary, 'metadata.json'), JSON.stringify(file), { mode: 0o600, flag: 'wx' })
      syncDirectory(join(this.temporary, 'content'))
      syncDirectory(this.temporary)
      await locked(`files-${this.session}`, () => {
        findSession(readRegistry(), this.session)
        const files = listFiles(this.session)
        if (
          files.length >= maxSessionFiles ||
          files.reduce((sum, item) => sum + item.size, 0) + file.size > maxTotalBytes
        )
          throw new RegistryError(
            'Session file storage is full (100 files / 256 MiB). Remove files before adding more.',
          )
        renameSync(this.temporary, join(filesDirectory(this.session), file.id))
        syncDirectory(filesDirectory(this.session))
      })
      return file
    } finally {
      this.abort()
    }
  }
  abort() {
    try {
      closeSync(this.descriptor)
    } catch {
      /* Already closed. */
    }
    rmSync(this.temporary, { recursive: true, force: true })
  }
}

/** The agent shares a file from its filesystem: a snapshot, so a source changed
 * or deleted later cannot change the stored file. */
export async function publish(session: string, path: unknown, name?: unknown) {
  if (typeof path !== 'string' || !path || path.length > 4096) throw new RegistryError('Provide a file path', 400)
  if (!isAbsolute(path)) throw new RegistryError('Use an absolute path for the file to publish', 400)
  const before = statSync(path)
  if (!before.isFile()) throw new RegistryError('Only regular files can be published', 400)
  if (before.size > maxSessionFileBytes) throw new RegistryError('Files must be at most 32 MiB.', 413)
  const stored = new StoredFile(session, typeof name === 'string' ? name : path.split('/').at(-1)!, 'published')
  try {
    const descriptor = openSync(path, 'r')
    try {
      const block = Buffer.alloc(64 * 1024)
      for (let read; (read = readSync(descriptor, block)) > 0;) stored.write(Buffer.from(block.subarray(0, read)))
      const after = fstatSync(descriptor)
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
        throw new RegistryError('File changed while publishing. Finish writing it and retry.')
    } finally {
      closeSync(descriptor)
    }
  } catch (error) {
    stored.abort()
    throw error
  }
  return stored.commit()
}

export function readFile(session: string, id: unknown) {
  if (!sessionFileId(id)) throw new RegistryError('Invalid session file ID.', 400)
  let file: SessionFile
  try {
    file = parseSessionFile(JSON.parse(readFileSync(join(filesDirectory(session), id, 'metadata.json'), 'utf8')))
  } catch {
    throw new RegistryError('Session file not found', 404)
  }
  const path = contentPath(session, file)
  if (statSync(path).size !== file.size) throw new RegistryError('The stored file is incomplete.', 500)
  return { file, path }
}

export function removeFile(session: string, id: unknown) {
  if (!sessionFileId(id)) throw new RegistryError('Invalid session file ID.', 400)
  return locked(`files-${session}`, () => {
    const directory = join(filesDirectory(session), id)
    // Readers never see a partly deleted file.
    const discarded = join(filesDirectory(session), `.removed-${randomUUID()}`)
    try {
      renameSync(directory, discarded)
    } catch {
      return
    }
    rmSync(discarded, { recursive: true, force: true })
  })
}

export const removeSessionFiles = (session: string) =>
  locked(`files-${session}`, () => rmSync(filesDirectory(session), { recursive: true, force: true }))

// Images pasted into a terminal: saved where the coding tool can read them by path.

/** Check an image upload before its bytes arrive. */
export function checkImage(session: string, extension: unknown, size: unknown) {
  findSession(readRegistry(), session)
  if (!Object.values(imageExtensions).includes(extension as never))
    throw new RegistryError('Unsupported image type. Use a PNG, JPEG, GIF, or WebP image.', 400)
  if (!Number.isSafeInteger(size) || (size as number) <= 0 || (size as number) > maxImageBytes)
    throw new RegistryError('Images must be between 1 byte and 16 MB.', 413)
}

let pasted = 0

/** Save a pasted image, keeping each session's newest 20. Names sort by age. */
export function saveImage(session: string, extension: string, data: Buffer) {
  const directory = statePath('clipboard', session)
  const order = `${new Date().toISOString().replace(/[-:.]/g, '')}-${String(++pasted % 1e6).padStart(6, '0')}`
  const name = `${order}-${randomUUID().slice(0, 8)}.${extension}`
  const path = join(directory, name)
  writeFile(path, data)
  for (const stale of readdirSync(directory)
    .filter(item => !item.startsWith('.'))
    .sort()
    .slice(0, -20))
    rmSync(join(directory, stale), { force: true })
  return { path, reference: path }
}
