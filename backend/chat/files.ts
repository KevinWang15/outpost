import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  maxSessionFileBytes,
  parseSessionFile,
  sessionFileId,
  sessionFileName,
  sniffMediaType,
  type SessionFile,
} from '../../shared/sessionFiles'
import { AppError } from '../errors'

const stagedLifetime = 60 * 60_000
/** Files of one channel, as for a session's store on its target. */
const maxChannelFiles = 1000

/** Files the user attached to channel posts, kept with the channel on the
 * server (members' own files stay in their sessions). An upload waits in
 * `.staged` until its post commits it; uncommitted uploads expire. Layout as on
 * targets: `<id>/metadata.json` and `<id>/content`. */
export class ChannelFiles {
  constructor(private directory: string) {}

  private staged(id: string) {
    return join(this.directory, '.staged', id)
  }
  private stored(channelId: string, id: string) {
    return join(this.directory, channelId, id)
  }

  async stage(name: string, data: Buffer): Promise<SessionFile> {
    if (!sessionFileName(name)) throw new AppError('Use a filename without folders or control characters.')
    if (data.length > maxSessionFileBytes) throw new AppError('Files must be at most 32 MiB.', 413)
    await this.sweep()
    const file: SessionFile = {
      id: randomUUID().replace(/-/g, ''),
      name,
      createdAt: new Date().toISOString(),
      size: data.length,
      mediaType: sniffMediaType(data.subarray(0, 16)),
      source: 'received',
    }
    const temporary = join(this.directory, '.staged', `.${file.id}.tmp`)
    await mkdir(temporary, { recursive: true, mode: 0o700 })
    try {
      await write(join(temporary, 'content'), data)
      await write(join(temporary, 'metadata.json'), JSON.stringify(file))
      await rename(temporary, this.staged(file.id))
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
    return file
  }

  /** Move a post's staged uploads into its channel. */
  async commit(channelId: string, ids: string[]): Promise<SessionFile[]> {
    const files = await Promise.all(ids.map(id => this.metadata(this.staged(id))))
    if (files.some(file => !file)) throw new AppError('An attachment expired. Attach it again.', 410)
    if ((await this.list(channelId)).length + ids.length > maxChannelFiles)
      throw new AppError('This channel has too many files.', 409)
    await mkdir(join(this.directory, channelId), { recursive: true, mode: 0o700 })
    for (const id of ids) await rename(this.staged(id), this.stored(channelId, id))
    return files as SessionFile[]
  }

  async list(channelId: string): Promise<SessionFile[]> {
    const names = await readdir(join(this.directory, channelId)).catch(() => [])
    const files = await Promise.all(names.filter(sessionFileId).map(id => this.metadata(this.stored(channelId, id))))
    return files
      .filter((file): file is SessionFile => file !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  }

  async read(channelId: string, id: string) {
    if (!sessionFileId(id)) throw new AppError('Invalid file ID.')
    const file = await this.metadata(this.stored(channelId, id))
    if (!file) throw new AppError('File not found.', 404)
    const bytes = await readFile(join(this.stored(channelId, id), 'content'))
    if (bytes.length !== file.size) throw new AppError('The stored file is incomplete.', 500)
    return { file, bytes }
  }

  async removeChannel(channelId: string) {
    await rm(join(this.directory, channelId), { recursive: true, force: true })
  }

  private async metadata(directory: string): Promise<SessionFile | null> {
    try {
      return parseSessionFile(JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8')))
    } catch {
      return null
    }
  }

  private async sweep() {
    const directory = join(this.directory, '.staged')
    const now = Date.now()
    for (const name of await readdir(directory).catch(() => [])) {
      const path = join(directory, name)
      const info = await stat(path).catch(() => null)
      if (info && now - info.mtimeMs > stagedLifetime) await rm(path, { recursive: true, force: true })
    }
  }
}

async function write(path: string, data: string | Buffer) {
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(data)
    await file.sync()
  } finally {
    await file.close()
  }
}
