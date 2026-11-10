import { randomUUID } from 'node:crypto'
import { appendFile, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Channel, ChannelMessage, Delivery, Schedule } from '../../shared/chatApi'
import { AppError } from '../errors'

interface ChannelsFile {
  version: 1
  channels: Channel[]
  /** Last read message time per channel. */
  reads: Record<string, string>
  /** Per channel and member (`target/session`): the last message it received. */
  cursors: Record<string, Record<string, string>>
}
interface DeliveriesFile {
  version: 1
  deliveries: Delivery[]
}
interface SchedulesFile {
  version: 1
  schedules: Schedule[]
  /** The minute each schedule last fired, so one minute fires once. */
  fired: Record<string, string>
}
interface ThreadsFile {
  version: 1
  /** Session-to-session threads: hops so far and when they began. */
  threads: Record<string, { hops: number; at: string }>
}

const recent = 500
const keep = { deliveries: 300, threads: 500 }
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** One owner's chat state, in `<workspace>/chat`. Channel messages are
 * append-only JSONL; other files are replaced atomically. The Outpost server is
 * the only writer (one instance per data directory). */
export class ChatStore {
  private queue: Promise<unknown> = Promise.resolve()
  private loaded: Promise<void> | null = null
  channels!: ChannelsFile
  deliveries!: DeliveriesFile
  schedules!: SchedulesFile
  threads!: ThreadsFile
  private messages = new Map<string, ChannelMessage[]>()
  private complete = new Set<string>()

  constructor(readonly directory: string) {}

  load() {
    this.loaded ??= (async () => {
      this.channels = await this.read(
        'channels.json',
        { version: 1, channels: [], reads: {}, cursors: {} },
        data => Array.isArray(data.channels) && record(data.reads) && record(data.cursors),
      )
      this.deliveries = await this.read('deliveries.json', { version: 1, deliveries: [] }, data =>
        Array.isArray(data.deliveries),
      )
      this.schedules = await this.read(
        'schedules.json',
        { version: 1, schedules: [], fired: {} },
        data => Array.isArray(data.schedules) && record(data.fired),
      )
      this.threads = await this.read('threads.json', { version: 1, threads: {} }, data => record(data.threads))
    })()
    return this.loaded
  }

  private async read<T extends { version: 1 }>(
    name: string,
    empty: T,
    valid: (data: Record<string, unknown>) => boolean,
  ) {
    let raw: string
    try {
      raw = await readFile(join(this.directory, name), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty
      throw error
    }
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      data = null
    }
    if (!record(data) || data.version !== 1 || !valid(data))
      throw new AppError(`Invalid chat/${name}. Expected the current schema; no data was modified.`, 409)
    return data as unknown as T
  }

  /** Serialize changes; `files` names what to persist afterwards. */
  change<T>(files: ('channels' | 'deliveries' | 'schedules' | 'threads')[], action: () => T | Promise<T>): Promise<T> {
    const work = this.queue.then(async () => {
      await this.load()
      const result = await action()
      for (const file of files) await this.save(file)
      return result
    })
    this.queue = work.catch(() => {})
    return work
  }

  private async prepare() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await chmod(this.directory, 0o700)
  }

  private async save(file: 'channels' | 'deliveries' | 'schedules' | 'threads') {
    if (file === 'deliveries') {
      const done = this.deliveries.deliveries.filter(item => item.state === 'done' || item.state === 'failed')
      if (done.length > keep.deliveries) {
        const drop = new Set(done.slice(0, done.length - keep.deliveries))
        this.deliveries.deliveries = this.deliveries.deliveries.filter(item => !drop.has(item))
      }
    }
    if (file === 'threads') {
      const entries = Object.entries(this.threads.threads)
      if (entries.length > keep.threads)
        this.threads.threads = Object.fromEntries(
          entries.sort((a, b) => a[1].at.localeCompare(b[1].at)).slice(-keep.threads),
        )
    }
    await this.prepare()
    const path = join(this.directory, `${file}.json`)
    const temporary = join(this.directory, `${file}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, `${JSON.stringify(this[file], null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  // Channel messages ------------------------------------------------------------------

  private messagesPath(channelId: string) {
    return join(this.directory, 'messages', `${channelId}.jsonl`)
  }

  private async all(channelId: string): Promise<ChannelMessage[]> {
    let raw = ''
    try {
      raw = await readFile(this.messagesPath(channelId), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const messages: ChannelMessage[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        messages.push(JSON.parse(line))
      } catch {
        // A torn final line from a crash is skipped; earlier lines are intact.
      }
    }
    return messages
  }

  /** The newest messages, cached; the cache holds the latest `recent`. */
  async recent(channelId: string): Promise<ChannelMessage[]> {
    let cached = this.messages.get(channelId)
    if (!cached) {
      const all = await this.all(channelId)
      cached = all.slice(-recent)
      if (all.length <= recent) this.complete.add(channelId)
      this.messages.set(channelId, cached)
    }
    return cached
  }

  async page(channelId: string, before: string | null, limit: number) {
    let messages = await this.recent(channelId)
    let index = before ? messages.findIndex(message => message.id === before) : messages.length
    if (index < 0 || (index < limit && !this.complete.has(channelId))) {
      messages = await this.all(channelId)
      index = before ? messages.findIndex(message => message.id === before) : messages.length
      if (index < 0) index = messages.length
    }
    return { messages: messages.slice(Math.max(0, index - limit), index), more: index > limit }
  }

  async append(message: ChannelMessage) {
    await this.change([], async () => {
      await this.prepare()
      await mkdir(join(this.directory, 'messages'), { recursive: true, mode: 0o700 })
      await appendFile(this.messagesPath(message.channelId), `${JSON.stringify(message)}\n`, { mode: 0o600 })
      const cached = await this.recent(message.channelId)
      cached.push(message)
      if (cached.length > recent) {
        cached.splice(0, cached.length - recent)
        this.complete.delete(message.channelId)
      }
    })
    return message
  }

  async lastAt(channelId: string) {
    return (await this.recent(channelId)).at(-1)?.at ?? null
  }

  async removeMessages(channelId: string) {
    this.messages.delete(channelId)
    this.complete.delete(channelId)
    await rm(this.messagesPath(channelId), { force: true })
  }
}
