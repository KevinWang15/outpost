import { appendFile, chmod, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Ajv } from 'ajv'
import Type, { type Static } from 'typebox'
import {
  channelMessage,
  channelRecord,
  deliveryRecord,
  scheduleRecord,
  type ChannelMessage,
} from '../../shared/chatApi'
import { AppError } from '../errors'
import { writeJsonFile } from '../../shared/node/jsonFile'
import { readStateFile } from '../stateFile'

const strict = { additionalProperties: false } as const
const version = Type.Literal(1)
const strings = Type.Record(Type.String(), Type.String())
const channelsFile = Type.Object(
  {
    version,
    channels: Type.Array(channelRecord),
    reads: strings,
    /** Per channel and member (`target/session`): the last message it received. */
    cursors: Type.Record(Type.String(), strings),
  },
  strict,
)
const deliveriesFile = Type.Object({ version, deliveries: Type.Array(deliveryRecord) }, strict)
const schedulesFile = Type.Object({ version, schedules: Type.Array(scheduleRecord), fired: strings }, strict)
const threadsFile = Type.Object(
  {
    version,
    threads: Type.Record(
      Type.String(),
      Type.Object(
        {
          hops: Type.Integer({ minimum: 0 }),
          at: Type.String(),
        },
        strict,
      ),
    ),
  },
  strict,
)
const ajv = new Ajv()
const validate = <S extends Type.TSchema>(schema: S) => ajv.compile<Static<S>>(schema)
const valid = {
  channels: validate(channelsFile),
  deliveries: validate(deliveriesFile),
  schedules: validate(schedulesFile),
  threads: validate(threadsFile),
}
const validMessage = validate(channelMessage)

const recent = 500
const keep = { deliveries: 300, threads: 500 }

interface ChannelHistory {
  messages: ChannelMessage[]
  complete: boolean
  /** A post keeps its draft key for the lifetime of its channel, including beyond the display cache. */
  postIds: Map<string, string>
}

function indexPost(postIds: Map<string, string>, message: ChannelMessage) {
  if (message.author.kind === 'user' && message.key && !postIds.has(message.key)) postIds.set(message.key, message.id)
}

/** One owner's chat state, in `<workspace>/chat`. Channel messages are
 * append-only JSONL; other files are replaced atomically. The Outpost server is
 * the only writer (one instance per data directory). */
export class ChatStore {
  private queue: Promise<unknown> = Promise.resolve()
  private loaded: Promise<void> | null = null
  channels!: Static<typeof channelsFile>
  deliveries!: Static<typeof deliveriesFile>
  schedules!: Static<typeof schedulesFile>
  threads!: Static<typeof threadsFile>
  private histories = new Map<string, Promise<ChannelHistory>>()

  constructor(readonly directory: string) {}

  load() {
    this.loaded ??= (async () => {
      this.channels = await readStateFile(
        join(this.directory, 'channels.json'),
        { version: 1, channels: [], reads: {}, cursors: {} },
        valid.channels,
      )
      this.deliveries = await readStateFile(
        join(this.directory, 'deliveries.json'),
        { version: 1, deliveries: [] },
        valid.deliveries,
      )
      this.schedules = await readStateFile(
        join(this.directory, 'schedules.json'),
        { version: 1, schedules: [], fired: {} },
        valid.schedules,
      )
      this.threads = await readStateFile(
        join(this.directory, 'threads.json'),
        { version: 1, threads: {} },
        valid.threads,
      )
    })()
    return this.loaded
  }

  /** Serialize changes; `files` names what to persist afterwards. */
  change<T>(files: ('channels' | 'deliveries' | 'schedules' | 'threads')[], action: () => T | Promise<T>): Promise<T> {
    const work = this.queue.then(async () => {
      await this.load()
      const result = await action()
      for (const file of files) {
        if (!valid[file](this[file])) {
          this.loaded = null
          await this.load()
          throw new AppError(`Cannot save invalid chat/${file}.json.`, 409)
        }
      }
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
    await writeJsonFile(join(this.directory, `${file}.json`), this[file])
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
    if (!raw) return []
    if (!raw.endsWith('\n')) throw new AppError('The channel message log has an incomplete final record.', 409)
    const messages: ChannelMessage[] = []
    for (const line of raw.slice(0, -1).split('\n')) {
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        /* An invalid line fails the entire read below. */
      }
      if (!validMessage(message) || message.channelId !== channelId)
        throw new AppError('Invalid record in the channel message log.', 409)
      messages.push(message)
    }
    return messages
  }

  private history(channelId: string) {
    let history = this.histories.get(channelId)
    if (!history) {
      history = this.all(channelId).then(all => {
        const postIds = new Map<string, string>()
        for (const message of all) indexPost(postIds, message)
        return { messages: all.slice(-recent), complete: all.length <= recent, postIds }
      })
      this.histories.set(channelId, history)
      void history.catch(() => {
        if (this.histories.get(channelId) === history) this.histories.delete(channelId)
      })
    }
    return history
  }

  async postId(channelId: string, key: string) {
    return (await this.history(channelId)).postIds.get(key)
  }

  async recent(channelId: string): Promise<ChannelMessage[]> {
    return (await this.history(channelId)).messages
  }

  async page(channelId: string, before: string | null, limit: number) {
    const history = await this.history(channelId)
    let messages = history.messages
    let index = before ? messages.findIndex(message => message.id === before) : messages.length
    if (index < 0 || (index < limit && !history.complete)) {
      messages = await this.all(channelId)
      index = before ? messages.findIndex(message => message.id === before) : messages.length
      if (index < 0) index = messages.length
    }
    return { messages: messages.slice(Math.max(0, index - limit), index), more: index > limit }
  }

  async append(message: ChannelMessage) {
    return this.change([], () => this.appendInChange(message))
  }

  /** Append within an existing store change so a roster update and its notice stay ordered. */
  async appendInChange(message: ChannelMessage) {
    if (!validMessage(message)) throw new AppError('Invalid channel message.', 409)
    await this.prepare()
    await mkdir(join(this.directory, 'messages'), { recursive: true, mode: 0o700 })
    const history = await this.history(message.channelId)
    await appendFile(this.messagesPath(message.channelId), `${JSON.stringify(message)}\n`, { mode: 0o600 })
    indexPost(history.postIds, message)
    history.messages.push(message)
    if (history.messages.length > recent) {
      history.messages.splice(0, history.messages.length - recent)
      history.complete = false
    }
    return message
  }

  async lastAt(channelId: string) {
    return (await this.recent(channelId)).at(-1)?.at ?? null
  }

  async removeMessages(channelId: string) {
    this.histories.delete(channelId)
    await rm(this.messagesPath(channelId), { force: true })
  }
}
