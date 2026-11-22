import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import type * as acp from '@agentclientprotocol/sdk'
import { ChatJournal, chatHost, validChatOrigin, type ChatEntryInput, type ChatInfo } from '../shared/chatHost'
import type { SessionRecord } from '../shared/model'
import type { SessionActivity } from '../shared/activity'
import { sessionFileId } from '../shared/sessionFiles'
import { request } from './drivers'
import { terminalSocket } from './launch'
import { harness } from './harnesses'
import { current, readRegistry, session as findSession } from './registry'
import { readJson, statePath } from './state'
import { lines, reverseRecords, Scan } from './stores'
import { filesDirectory, listFiles, readFile } from './files'
import type { SessionFile } from '../shared/sessionFiles'
import type { Delivery } from './delivery'
import { ViewStream } from './viewStream'

const chatHeader = /^\[Outpost: Chat ([A-Za-z0-9_-]{1,80})\]\n/
const keyPattern = /^[A-Za-z0-9_-]{1,80}$/
const textBlock = (text: string) => ({ type: 'text' as const, text })
const signature = (path: string) => {
  const s = statSync(path, { throwIfNoEntry: false })
  return s ? [s.ino, s.mtimeMs, s.size].join(':') : ''
}
type Message = { id: string; role: 'user' | 'assistant'; text: string; at: string; turnId: string | null }
type Entry = { event: ChatEntryInput; at: string }

/** Follow only committed conversation records. Raw keystrokes, TUI redraws and drafts are never mirrored. */
class ConversationTail {
  messages: Message[] = []
  private bytes = 0
  private path = ''
  private identity = ''
  private offset = 0
  private conversation = ''
  private lookup = 0
  private format = ''
  private modified = 0
  private adapter
  constructor(private record: SessionRecord) {
    this.adapter = harness(record.tool)
  }

  refresh(conversation: string) {
    if (this.conversation !== conversation || Date.now() >= this.lookup) {
      this.path = this.adapter.transcript(this.record, conversation) ?? ''
      this.lookup = Date.now() + (this.path ? 5000 : 500)
    }
    const switched = this.conversation !== conversation
    this.conversation = conversation
    if (!this.path) {
      if (switched) {
        this.messages = []
        this.bytes = 0
        this.identity = ''
        this.offset = 0
      }
      return switched
    }
    const stat = statSync(this.path, { throwIfNoEntry: false })
    if (!stat?.isFile()) return switched
    const identity = this.path + ':' + stat.dev + ':' + stat.ino
    const reset =
      switched ||
      identity !== this.identity ||
      stat.size < this.offset ||
      (stat.size === this.offset && stat.mtimeMs !== this.modified)
    this.modified = stat.mtimeMs
    if (reset) {
      this.messages = []
      this.bytes = 0
      this.identity = identity
      this.offset = 0
      // Use the harness's own format discriminator (some tools have multiple stores).
      this.format = this.adapter.historySession(
        this.path,
        this.adapter.storeOf(this.record),
        new Scan(),
        new Map(),
      ).format
      const recent = []
      for (const entry of reverseRecords(this.path, stat.size)) {
        recent.push(entry)
        if (recent.length >= 2000 || stat.size - entry.offset > 2 * 1024 * 1024) break
      }
      for (const { record, offset } of recent.reverse()) this.add(record, offset)
      return true
    }
    if (this.offset === stat.size) return false
    const before = this.offset
    for (const { record, end } of lines(this.path, this.offset)) {
      this.offset = end
      if (record) this.add(record, end)
    }
    return before !== this.offset
  }

  private add(record: Record<string, unknown>, offset: number) {
    this.offset = offset
    let index = 0
    for (const m of this.adapter.historyMessages(record, this.format)) {
      if (m.kind !== 'message' || m.role === 'tool' || !m.text.trim()) continue
      const text = m.text.slice(0, chatHost.maxText)
      this.messages.push({ id: offset + '-' + index++, role: m.role, text, at: m.timestamp ?? '', turnId: m.turnId })
      this.bytes += text.length
      while (this.messages.length > 300 || this.bytes > 512 * 1024) this.bytes -= this.messages.shift()!.text.length
    }
  }
}

/** A Chat subscriber to the running PTY, using the same durable delivery queue as channels. */
export class TerminalChat extends ViewStream {
  private tail
  private connected = false
  private timer?: NodeJS.Timeout
  private refreshing = false
  private registryStamp = ''
  private queueStamp = ''
  private receipts: Delivery[] = []
  private journal = new ChatJournal()
  private previous: Entry[] = []
  private state = ''
  private activity?: SessionActivity
  private readonly started = new Date().toISOString()
  private readonly socket
  private readonly instance
  private fileStamp = ''
  private files: SessionFile[] = []
  private conversation = ''

  constructor(
    private record: SessionRecord,
    private pid: number,
  ) {
    super()
    this.tail = new ConversationTail(record)
    this.socket = terminalSocket(record.id)
    this.instance = 'pty-' + record.id + '-' + pid
    this.once('close', () => clearInterval(this.timer))
  }

  private info(): ChatInfo {
    return {
      state: 'ready',
      nativeTerminal: { delivery: this.record.delivery },
      error: null,
      agent: null,
      nativeId: this.conversation,
      title: this.record.name,
      modes: null,
      config: [],
      commands: [],
      usage: null,
      images: false,
      instructions: 'none',
      activity: this.activity!,
    }
  }
  private snapshot() {
    this.control({
      type: 'welcome',
      protocol: chatHost.protocol,
      instance: this.instance,
      info: this.info(),
      journal: this.journal.snapshot(),
    })
  }

  private async refresh(first = false) {
    if (this.refreshing || this.destroyed) return
    this.refreshing = true
    try {
      const status = await request<{ pid: number; activity: SessionActivity }>(this.socket, { type: 'status' })
      if (this.destroyed) return
      if (!status || status.pid !== this.pid) {
        this.push(null)
        clearInterval(this.timer)
        return
      }
      const registryStamp = signature(statePath('registry.json'))
      if (registryStamp !== this.registryStamp) {
        this.record = findSession(readRegistry(), this.record.id)
        this.registryStamp = registryStamp
      }
      const { state, updatedAt, completionId, detail, observation } = status.activity
      const signatureOfActivity = JSON.stringify([
        state,
        updatedAt,
        completionId,
        detail,
        observation,
        this.record.delivery,
      ])
      const infoChanged = this.state !== signatureOfActivity
      this.activity = status.activity
      this.state = signatureOfActivity
      this.conversation = current(this.record).id
      const changed = this.tail.refresh(this.conversation)
      const queue = statePath('deliveries', this.record.id + '.json')
      const stamp = signature(queue),
        queueChanged = stamp !== this.queueStamp
      if (queueChanged) {
        this.queueStamp = stamp
        this.receipts = readJson<{ items: Delivery[] }>(queue, { items: [] }, 16 * 1024 * 1024).items.filter(
          d => d.text.match(chatHeader)?.[1] === d.key,
        )
      }
      const files = signature(filesDirectory(this.record.id))
      const filesChanged = files !== this.fileStamp
      this.fileStamp = files
      if (filesChanged)
        this.files = listFiles(this.record.id)
          .filter(f => f.source === 'published')
          .reverse()
      if (first || changed || queueChanged || infoChanged || filesChanged) this.update(first)
      if (!first && infoChanged) this.control({ type: 'info', info: this.info() })
    } finally {
      this.refreshing = false
    }
  }

  private update(first: boolean) {
    const entries: Entry[] = []
    let turn: string | null = null,
      at = this.started
    const seen = new Set<string>()
    const nativeTurns = new Map<string, string>()
    const add = (event: ChatEntryInput) => entries.push({ event, at })
    const end = () => {
      if (turn) add({ kind: 'ended', turn, stopReason: 'end_turn', error: null })
      turn = null
    }
    const start = (id: string, text: string, key: string | null) => {
      turn = id
      add({ kind: 'queued', turn, key, origin: { kind: 'user' }, prompt: [textBlock(text)] })
      add({ kind: 'started', turn })
    }
    for (const m of this.tail.messages) {
      at = m.at || this.started
      if (m.role === 'user') {
        end()
        const key = m.text.match(chatHeader)?.[1] ?? null
        if (key) seen.add(key)
        const id = key ?? 'terminal-' + m.id
        if (m.turnId) nativeTurns.set(m.turnId, id)
        start(id, m.text.replace(chatHeader, ''), key)
      } else
        add({
          kind: 'update',
          turn: (m.turnId && nativeTurns.get(m.turnId)) || turn,
          update: { sessionUpdate: 'agent_message_chunk', messageId: m.id, content: textBlock(m.text) },
        })
    }
    if (!['working', 'waiting'].includes(this.activity!.state)) end()
    for (const d of this.receipts) {
      if (seen.has(d.key)) continue
      // Old completed turns outside the bounded transcript already live in native history.
      if (
        d.typedAt &&
        this.tail.messages.length &&
        d.typedAt < Date.parse(this.tail.messages[0].at) - 1000 &&
        d.state === 'done'
      )
        continue
      at = d.typedAt ? new Date(d.typedAt).toISOString() : this.started
      add({
        kind: 'queued',
        turn: d.key,
        key: d.key,
        origin: { kind: 'user' },
        prompt: [textBlock(d.text.replace(chatHeader, ''))],
      })
      if (d.state === 'waiting') continue
      add({ kind: 'started', turn: d.key })
      if (d.state === 'typed') continue
      if (
        d.reply &&
        !this.tail.messages.some(
          m => m.role === 'assistant' && m.text === d.reply && Math.abs(Date.parse(m.at) - (d.typedAt ?? 0)) < 60000,
        )
      )
        add({
          kind: 'update',
          turn: d.key,
          update: { sessionUpdate: 'agent_message_chunk', content: textBlock(d.reply) },
        })
      add({ kind: 'ended', turn: d.key, stopReason: d.state === 'failed' ? 'error' : 'end_turn', error: d.error })
    }
    for (const file of this.files) entries.push({ at: file.createdAt, event: { kind: 'file', file, turn: null } })
    const extendsJournal =
      !first &&
      this.previous.length <= entries.length &&
      this.previous.every(
        (e, i) => e.at === entries[i].at && JSON.stringify(e.event) === JSON.stringify(entries[i].event),
      )
    if (!extendsJournal) this.journal = new ChatJournal()
    for (const { event, at } of entries.slice(extendsJournal ? this.previous.length : 0)) {
      const entry = this.journal.record(event, at)
      if (extendsJournal) this.control({ type: 'entry', entry })
    }
    this.previous = entries
    if (!extendsJournal) this.snapshot()
  }

  protected async receive(kind: string, payload: Buffer) {
    if (kind !== 'C') throw Error('Invalid chat frame.')
    const m = JSON.parse(payload.toString())
    if (!this.connected) {
      if (m.type !== 'hello' || m.protocol !== chatHost.protocol) throw Error('Invalid chat handshake.')
      this.connected = true
      await this.refresh(true)
      if (!this.destroyed && !this.readableEnded && this.activity)
        this.timer = setInterval(() => {
          void this.refresh().catch(e => this.destroy(e))
        }, 750).unref()
      return
    }
    if (typeof m.id !== 'string' || !keyPattern.test(m.id)) throw Error('Invalid chat request.')
    const result = (ok: boolean, message?: string, data?: unknown) =>
      this.control({ type: 'result', id: m.id, ok, message, data })
    try {
      if (m.type === 'ping') return result(true)
      if (m.type === 'seen') {
        await request(this.socket, { type: 'acknowledge', completionId: m.completionId })
        return result(true)
      }
      if (m.type === 'unqueue') {
        const r = await request(this.socket, { type: 'undeliver', key: m.turn })
        return result(r?.ok === true, 'This message already started or was removed.')
      }
      if (m.type !== 'prompt') return result(false, 'Use the coding tool’s terminal for this action.')
      if (!validChatOrigin(m.origin)) return result(false, 'Invalid message origin.')
      if (
        !Array.isArray(m.prompt) ||
        !Array.isArray(m.files) ||
        m.files.length > chatHost.maxFiles ||
        !m.files.every(sessionFileId) ||
        !m.prompt.every((b: acp.ContentBlock) => b?.type === 'text' && typeof b.text === 'string')
      )
        return result(false, 'Invalid message or attachments.')
      const key = m.key === null ? randomUUID() : m.key
      if (typeof key !== 'string' || !keyPattern.test(key)) return result(false, 'Invalid message key.')
      const body = m.prompt.map((b: acp.TextContent) => b.text).join('\n')
      const attachments = m.files.map((id: string) => readFile(this.record.id, id).path)
      const text = [body, ...attachments].filter(Boolean).join('\n')
      // The PTY accepts text from Chat, including line breaks. Reject terminal control sequences.
      if (
        !text.trim() ||
        Buffer.byteLength(text) > 63 * 1024 ||
        Array.from(text as string).some(c => (c < ' ' && c !== '\n' && c !== '\t') || (c >= '\x7f' && c <= '\x9f'))
      )
        return result(false, 'Enter a message of up to 63 KiB without terminal control characters.')
      const reply = await request(this.socket, { type: 'deliver', key, text: '[Outpost: Chat ' + key + ']\n' + text })
      if (reply?.ok !== true) return result(false, 'The terminal stopped before accepting this message.')
      await this.refresh()
      result(true, undefined, { turn: key })
    } catch (error) {
      result(false, (error as Error).message)
    }
  }
}
