import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import { createInterface } from 'node:readline'
import { PassThrough, Writable } from 'node:stream'
import headless from '@xterm/headless'
import type * as acp from '@agentclientprotocol/sdk'
import { chatHost, type ChatEntry, type ChatHostMessage, type ChatHostRequest } from '../shared/chatHost'
import { FrameDecoder, terminalControl } from '../shared/node/terminalFrames'
import { checkpoint } from '../shared/terminalCheckpoint'
import { terminalSize } from '../shared/terminalService'
import { chatSocket } from './launch'
import { socketAddress } from './state'
import { TerminalFileRequests } from './terminalFileRequests'
import { ViewStream } from './viewStream'

/** Agent-provided text can be printed, but must never execute a terminal escape sequence. */
const printable = (text: string) =>
  Array.from(text)
    .filter(c => c === '\n' || c === '\t' || (c >= ' ' && !(c >= '\x7f' && c <= '\x9f')))
    .join('')
const contentText = (block: acp.ContentBlock) =>
  block.type === 'text' ? block.text : block.type === 'resource_link' ? block.name : '[' + block.type + ']'
const pasteStart = Buffer.from('\x1b[200~')
const pasteEnd = Buffer.from('\x1b[201~')
type Permission = Extract<ChatEntry, { kind: 'permission' }>

/** An interactive terminal client of the existing ACP host. Each viewer owns its draft. */
export class ChatTerminal extends ViewStream {
  private host
  private input = new PassThrough()
  private editorOutput = Object.assign(
    new Writable({
      write: (chunk, _encoding, done) => {
        this.display(chunk.toString())
        done()
      },
    }),
    { columns: 80 },
  )
  private editor = createInterface({
    input: this.input,
    output: this.editorOutput,
    terminal: true,
    prompt: '> ',
    historySize: 80,
  })
  private files: TerminalFileRequests
  private permissions = new Map<string, Permission>()
  private pending = ''
  private partial = Buffer.alloc(0)
  private paste: Buffer[] | null = null
  private pasteBytes = 0
  private replaying = false
  private ready = false

  constructor(
    session: string,
    private cols: number,
    private rows: number,
  ) {
    super()
    this.host = connect(socketAddress(chatSocket(session)))
    this.files = new TerminalFileRequests(
      session,
      msg => this.control(msg),
      () => this.control({ type: 'files' }),
    )
    this.editorOutput.columns = cols
    this.editor.on('line', line => this.submit(line))
    this.editor.on('SIGINT', () => {
      if (this.editor.line) {
        this.editor.write(null, { ctrl: true, name: 'u' })
        this.editor.prompt()
      } else this.send({ type: 'cancel', id: randomUUID() })
    })
    const decoder = new FrameDecoder()
    this.host.on('connect', () => this.send({ type: 'hello', protocol: chatHost.protocol }))
    this.host.on('data', bytes => {
      try {
        for (const frame of decoder.feed(Buffer.from(bytes))) {
          if (frame.kind !== 'C') throw Error('Invalid chat host frame.')
          this.event(JSON.parse(frame.payload.toString()))
        }
      } catch (error) {
        this.destroy(error as Error)
      }
    })
    this.host.on('error', error => this.destroy(error))
    this.host.on('close', () => {
      if (this.destroyed) return
      this.flush()
      this.display('\x1b[?2004l')
      this.control({ type: 'exit', reason: 'ended' })
      this.push(null)
    })
    this.once('close', () => {
      this.files.close()
      this.editor.close()
      this.input.destroy()
      this.editorOutput.destroy()
      this.host.destroy()
    })
  }

  private send(request: ChatHostRequest) {
    if (this.host.writableLength > 1024 * 1024) throw Error('Chat input is backed up.')
    this.host.write(terminalControl(request))
  }
  private print(text: string) {
    if (!text) return
    this.display('\r\x1b[2K' + printable(text).replaceAll('\n', '\r\n') + '\r\n')
    if (!this.replaying && this.ready) this.editor.prompt(true)
  }
  private flush() {
    if (this.pending) {
      this.print(this.pending.trimEnd())
      this.pending = ''
    }
  }
  private submit(line: string) {
    const text = line.replaceAll('\u2028', '\n').trim()
    if (!text) return this.editor.prompt()
    const answer = /^\/answer ([^\s]+) (\d+)$/.exec(text)
    if (answer) {
      const [, prefix, choice] = answer
      const matches = [...this.permissions.values()].filter(p => p.id.slice(0, 8) === prefix)
      const option = matches.length === 1 && matches[0].options[Number(choice) - 1]
      if (!option) return this.print('Use the answer command shown on the pending approval.')
      this.send({ type: 'permission', id: randomUUID(), request: matches[0].id, optionId: option.optionId })
    } else {
      this.send({
        type: 'prompt',
        id: randomUUID(),
        key: randomUUID(),
        origin: { kind: 'user' },
        prompt: [{ type: 'text', text }],
        files: [],
      })
    }
    this.editor.prompt()
  }
  private permission(p: Permission) {
    this.print(
      'Approval requested: ' +
        (p.toolCall.title ?? 'Tool call') +
        '\n' +
        p.options.map((o, i) => '/answer ' + p.id.slice(0, 8) + ' ' + (i + 1) + '  ' + o.name).join('\n'),
    )
  }
  private entry(e: ChatEntry) {
    if (e.kind === 'update') {
      const u = e.update
      if (u.sessionUpdate === 'agent_message_chunk') {
        this.pending += contentText(u.content)
        const end = this.pending.lastIndexOf('\n')
        if (end >= 0 || this.pending.length >= 4096) {
          const n = end >= 0 ? end + 1 : this.pending.length
          this.print(this.pending.slice(0, n).trimEnd())
          this.pending = this.pending.slice(n)
        }
        return
      }
      if (u.sessionUpdate === 'user_message_chunk' && !e.turn) {
        this.flush()
        this.print('You: ' + contentText(u.content))
      }
      if (u.sessionUpdate === 'tool_call') {
        this.flush()
        this.print('Tool: ' + u.title)
      }
      return
    }
    this.flush()
    if (e.kind === 'queued') this.print('You: ' + e.prompt.map(contentText).join('\n'))
    else if (e.kind === 'permission') {
      this.permissions.set(e.id, e)
      if (!this.replaying) this.permission(e)
    } else if (e.kind === 'resolved') {
      this.permissions.delete(e.id)
      if (!this.replaying) this.print('Approval answered.')
    } else if (e.kind === 'ended' && e.error) this.print(e.error)
    else if (e.kind === 'notice') this.print(e.text)
    else if (e.kind === 'file') {
      this.print('File: ' + e.file.name)
      if (!this.replaying) this.control({ type: 'files' })
    }
  }
  private event(message: ChatHostMessage) {
    if (message.type === 'welcome') {
      this.replaying = true
      // Both terminal clients restore a screen before accepting any live output.
      const screen = new headless.Terminal({ cols: this.cols, rows: this.rows, allowProposedApi: true })
      try {
        for (const part of checkpoint(screen)) this.control({ type: 'restore', checkpoint: part })
      } finally {
        screen.dispose()
      }
      this.display('\x1b[?2004h')
      this.print('Outpost Chat · Type a message and press Enter.')
      // Keep a reconnect bounded. All outstanding approvals still need to be actionable.
      const entries = message.journal.entries
      const tail = Math.max(0, entries.length - 200)
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]
        if (i >= tail || e.kind === 'permission' || e.kind === 'resolved') this.entry(e)
      }
      this.flush()
      for (const permission of this.permissions.values()) this.permission(permission)
      this.replaying = false
      this.ready = true
      this.editor.prompt()
      this.control({ type: 'activity', activity: message.info.activity })
      this.control({ type: 'ready' })
    } else if (message.type === 'entry') this.entry(message.entry)
    else if (message.type === 'info') this.control({ type: 'activity', activity: message.info.activity })
    else if (message.type === 'result' && !message.ok) this.print(message.message ?? 'The request was declined.')
    else if (message.type === 'error') this.print(message.message)
  }
  private insertPaste(value: string) {
    // Keep multiline paste inside readline's single editable line until the user presses Enter.
    const draft = printable(value.replace(/\r\n?/g, '\n')).replaceAll('\n', '\u2028')
    if (this.editor.line.length + draft.length > 128 * 1024) throw Error('Terminal input is too long.')
    const { line, cursor } = this.editor
    Object.assign(this.editor, {
      line: line.slice(0, cursor) + draft + line.slice(cursor),
      cursor: cursor + draft.length,
    })
    this.editor.prompt(true)
  }
  private keyboard(input: Buffer) {
    let bytes = this.partial.length ? Buffer.concat([this.partial, input]) : input
    this.partial = Buffer.alloc(0)
    while (bytes.length) {
      const marker = this.paste ? pasteEnd : pasteStart
      const index = bytes.indexOf(marker)
      let length = index < 0 ? bytes.length : index
      if (index < 0) {
        // A paste delimiter can cross any two network frames.
        for (let n = Math.min(length, marker.length - 1); n > 0; n--) {
          if (bytes.subarray(-n).equals(marker.subarray(0, n))) {
            this.partial = Buffer.from(bytes.subarray(-n))
            length -= n
            break
          }
        }
      }
      const part = bytes.subarray(0, length)
      if (this.paste) {
        this.pasteBytes += length
        if (this.pasteBytes > 128 * 1024) throw Error('Terminal paste is too long.')
        if (length) this.paste.push(part)
      } else if (length) this.input.write(part)
      if (index < 0) break
      if (this.paste) {
        this.insertPaste(Buffer.concat(this.paste, this.pasteBytes).toString())
        this.paste = null
        this.pasteBytes = 0
      } else this.paste = []
      bytes = bytes.subarray(index + marker.length)
    }
  }
  protected receive(kind: string, payload: Buffer) {
    if (kind === 'I') {
      if (payload.length > 64 * 1024 || this.editor.line.length + payload.length > 128 * 1024)
        throw Error('Terminal input is too long.')
      this.keyboard(payload)
      return
    }
    if (kind !== 'C') throw Error('Invalid terminal frame.')
    const m = JSON.parse(payload.toString())
    if (this.files.handle(m)) return
    switch (m.type) {
      case 'send':
      case 'paste':
        if (
          typeof m.data !== 'string' ||
          Buffer.byteLength(m.data) > 64 * 1024 ||
          this.editor.line.length + m.data.length > 128 * 1024
        )
          throw Error('Terminal input is too long.')
        if (m.type === 'paste') this.insertPaste(m.data)
        else this.keyboard(Buffer.from(m.data))
        break
      case 'ping':
        break
      case 'acknowledge':
        this.send({ type: 'seen', id: randomUUID(), completionId: m.completionId })
        break
      case 'clear':
        this.control({ type: 'clear' })
        this.editor.prompt()
        break
      case 'resize':
        if (!terminalSize(m.cols, m.rows)) throw Error('Invalid terminal size.')
        this.cols = m.cols
        this.rows = m.rows
        this.editorOutput.columns = m.cols
        this.control({ type: 'geometry', cols: m.cols, rows: m.rows })
        return
      case 'focus':
      case 'draft':
      case 'deliver-now':
        return
      default:
        throw Error('Unknown terminal request.')
    }
    if (typeof m.id === 'string') this.control({ type: 'result', id: m.id, ok: true })
  }
}
