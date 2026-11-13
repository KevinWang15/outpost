import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react'
import { ArrowUp, FileText, LoaderCircle, Paperclip, Square, X } from 'lucide-react'
import { chatHost } from '../../shared/chatHost'
import { maxSessionFileBytes } from '../../shared/sessionFiles'
import { fileSize } from '../terminal/sessionFiles'
import { newKey } from './client'

export interface Suggestion {
  value: string
  label: string
  detail?: string
}

/** Unsent text, per conversation, for this page. */
const drafts = new Map<string, string>()
const imageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const coarse = () => window.matchMedia?.('(pointer: coarse)').matches

export default function Composer({
  draftKey,
  placeholder,
  mentions = [],
  commands = [],
  onUpload,
  running = false,
  disabled = null,
  onSend,
  onStop,
}: {
  draftKey: string
  placeholder: string
  mentions?: Suggestion[]
  commands?: Suggestion[]
  /** Uploads one attached file and returns its ID; without it, nothing can be attached. */
  onUpload?: (file: File) => Promise<string>
  running?: boolean
  /** A reason sending is unavailable, shown instead of sending. */
  disabled?: string | null
  /** `key` stays the same when an unchanged draft is sent again, so the
   * server can tell a resend from a new message. `files` are uploaded IDs. */
  onSend: (text: string, files: string[], key: string) => Promise<void>
  onStop?: () => void
}) {
  const [text, setText] = useState(() => drafts.get(draftKey) ?? '')
  /** `url` previews an image. */
  const [files, setFiles] = useState<{ file: File; url: string | null }[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [active, setActive] = useState(0)
  const [caret, setCaret] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  /** The last attempt that was not confirmed: resending it keeps its key. */
  const attempt = useRef<{ key: string; text: string; files: File[] } | null>(null)
  /** Files already uploaded for this draft, so a resend does not store them again. */
  const uploaded = useRef(new Map<File, string>())
  /** Where the caret goes after an inserted suggestion renders, before any further key. */
  const caretAfter = useRef<number | null>(null)

  // Each conversation mounts its own composer (keyed views), so this runs per draft.
  useEffect(() => {
    if (!coarse()) input.current?.focus()
  }, [])
  useEffect(() => {
    if (text) drafts.set(draftKey, text)
    else drafts.delete(draftKey)
  }, [draftKey, text])
  useLayoutEffect(() => {
    const element = input.current
    if (!element) return
    if (caretAfter.current !== null) {
      element.setSelectionRange(caretAfter.current, caretAfter.current)
      caretAfter.current = null
    }
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, Math.round(window.innerHeight * 0.4))}px`
  }, [text])

  // The token being typed before the caret: @mention or a leading /command.
  const before = text.slice(0, caret)
  const token = before.match(/(?:^|\s)([@/])([\w-]*)$/)
  const kind = token
    ? token[1] === '@'
      ? 'mention'
      : before.trimStart().startsWith('/') && !before.trimStart().slice(1).includes(' ')
        ? 'command'
        : null
    : null
  const query = token?.[2].toLowerCase() ?? ''
  const options = (kind === 'mention' ? mentions : kind === 'command' ? commands : [])
    .filter(option => option.value.toLowerCase().startsWith(query) || option.label.toLowerCase().includes(query))
    .slice(0, 8)
  const open = Boolean(kind && options.length && dismissed !== `${caret}:${text}`)

  function accept(option: Suggestion) {
    const start = caret - (token![2].length + 1)
    const insert = `${token![1]}${option.value} `
    const next = text.slice(0, start) + insert + text.slice(caret)
    const position = start + insert.length
    caretAfter.current = position
    setText(next)
    setCaret(position)
  }

  function attach(list: Iterable<File>) {
    const added: { file: File; url: string | null }[] = []
    for (const file of list) {
      if (file.size > maxSessionFileBytes) {
        setError(`${file.name} is larger than ${maxSessionFileBytes / 1024 / 1024} MB.`)
        continue
      }
      added.push({ file, url: imageTypes.includes(file.type) ? URL.createObjectURL(file) : null })
    }
    if (files.length + added.length > chatHost.maxFiles) setError(`Attach at most ${chatHost.maxFiles} files at once.`)
    setFiles(current => [...current, ...added].slice(0, chatHost.maxFiles))
  }

  function detach(item: { file: File; url: string | null }) {
    if (item.url) URL.revokeObjectURL(item.url)
    uploaded.current.delete(item.file)
    setFiles(current => current.filter(other => other !== item))
  }

  async function send() {
    if (busy || disabled) return
    const body = text.trim()
    if (!body && !files.length) return
    setBusy(true)
    setError('')
    const attached = files.map(item => item.file)
    const last = attempt.current
    const same =
      last?.text === body &&
      last.files.length === attached.length &&
      last.files.every((file, i) => file === attached[i])
    const key = same ? last.key : newKey()
    attempt.current = { key, text: body, files: attached }
    try {
      const ids: string[] = []
      for (const file of attached) {
        let id = uploaded.current.get(file)
        if (!id) {
          id = await onUpload!(file)
          uploaded.current.set(file, id)
        }
        ids.push(id)
      }
      await onSend(body, ids, key)
      attempt.current = null
      uploaded.current.clear()
      for (const item of files) if (item.url) URL.revokeObjectURL(item.url)
      setText('')
      setFiles([])
      drafts.delete(draftKey)
    } catch (problem) {
      setError((problem as Error).message)
    } finally {
      setBusy(false)
      input.current?.focus()
    }
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setActive(index => (index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length)
        return
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault()
        accept(options[Math.min(active, options.length - 1)])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setDismissed(`${caret}:${text}`)
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !coarse()) {
      event.preventDefault()
      void send()
    } else if (event.key === 'Escape' && running && onStop) {
      event.preventDefault()
      onStop()
    }
  }

  return (
    <div
      className={`chat-composer ${disabled ? 'disabled' : ''}`}
      onDragOver={event => onUpload && event.dataTransfer.types.includes('Files') && event.preventDefault()}
      onDrop={(event: DragEvent) => {
        if (!onUpload || !event.dataTransfer.files.length) return
        event.preventDefault()
        attach(event.dataTransfer.files)
      }}
    >
      {open && (
        <ul className="suggestions" role="listbox" aria-label={kind === 'mention' ? 'Members' : 'Commands'}>
          {options.map((option, index) => (
            <li key={option.value} role="option" aria-selected={index === active}>
              <button
                onMouseDown={event => {
                  event.preventDefault()
                  accept(option)
                }}
              >
                <strong>
                  {kind === 'mention' ? '@' : '/'}
                  {option.value}
                </strong>
                <span>{option.detail ?? option.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {files.length > 0 && (
        <div className="attachments">
          {files.map((item, index) => (
            <span key={`${index}:${item.file.name}`} className={`attachment ${item.url ? '' : 'document'}`}>
              {item.url ? (
                <img src={item.url} alt={item.file.name} />
              ) : (
                <span className="attachment-file" title={item.file.name}>
                  <FileText size={16} />
                  <span>
                    <strong>{item.file.name}</strong>
                    <small>{fileSize(item.file.size)}</small>
                  </span>
                </span>
              )}
              <button
                className="icon-button"
                aria-label={`Remove ${item.file.name}`}
                disabled={busy}
                onClick={() => detach(item)}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-box">
        <textarea
          ref={input}
          rows={1}
          value={text}
          placeholder={disabled ?? placeholder}
          disabled={Boolean(disabled)}
          aria-label="Message"
          onChange={event => {
            setText(event.target.value)
            setCaret(event.target.selectionStart)
            setActive(0)
          }}
          onSelect={event => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={keyDown}
          onPaste={(event: ClipboardEvent) => {
            const pasted = [...event.clipboardData.files]
            if (!onUpload || !pasted.length) return
            event.preventDefault()
            attach(pasted)
          }}
        />
        <div className="composer-actions">
          {onUpload && (
            <>
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                onChange={event => {
                  if (event.target.files) attach(event.target.files)
                  event.target.value = ''
                }}
              />
              <button
                className="icon-button"
                aria-label="Attach files"
                title="Attach files"
                disabled={Boolean(disabled) || busy}
                onClick={() => picker.current?.click()}
              >
                <Paperclip size={17} />
              </button>
            </>
          )}
          {running && onStop && (
            <button className="icon-button stop" aria-label="Stop" title="Stop (Esc)" onClick={onStop}>
              <Square size={14} fill="currentColor" />
            </button>
          )}
          <button
            className="send"
            aria-label={running ? 'Queue message' : 'Send'}
            title={running ? 'Queue message (Enter)' : 'Send (Enter)'}
            disabled={busy || Boolean(disabled) || (!text.trim() && !files.length)}
            onClick={() => void send()}
          >
            {busy ? <LoaderCircle size={16} className="spin" /> : <ArrowUp size={16} />}
          </button>
        </div>
      </div>
      {error && (
        <p className="error composer-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
