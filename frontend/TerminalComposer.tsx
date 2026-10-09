import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent } from 'react'
import { ImagePlus, LoaderCircle, X } from 'lucide-react'
import type { SessionImage } from '../shared/session-manager'
import { imageMediaTypes } from '../shared/session-manager'
import { imageFileError, uploadSessionImage } from './image-upload'

function fitTextarea(element: HTMLTextAreaElement) {
  element.style.height = 'auto'
  if (element.value) element.style.height = `${element.scrollHeight + element.offsetHeight - element.clientHeight}px`
}

export default function TerminalComposer({ targetId, sessionId, connected, onSend, onBusyChange }: {
  targetId: string
  sessionId: string
  connected: boolean
  onSend: (data: string) => Promise<void>
  onBusyChange: (busy: boolean) => void
}) {
  const [text, setText] = useState(''), [file, setFile] = useState<File | null>(null), [preview, setPreview] = useState('')
  const [uploaded, setUploaded] = useState<SessionImage | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const textarea = useRef<HTMLTextAreaElement>(null), chooser = useRef<HTMLInputElement>(null)
  const alive = useRef(true), pending = useRef<AbortController | null>(null)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; pending.current?.abort() }
  }, [])
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])
  useLayoutEffect(() => { if (textarea.current) fitTextarea(textarea.current) }, [text])
  useEffect(() => {
    const element = textarea.current!
    let width = element.clientWidth, frame = 0
    const observer = new ResizeObserver(() => {
      if (element.clientWidth !== width) {
        width = element.clientWidth; cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => fitTextarea(element))
      }
    })
    observer.observe(element)
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [])
  function clearImage() { setFile(null); setPreview(''); setUploaded(null) }
  function pick(candidate: File | null | undefined) {
    if (!connected || pending.current || !candidate) return
    const failure = imageFileError(candidate)
    if (failure) { setError(failure); return }
    setFile(candidate); setPreview(URL.createObjectURL(candidate)); setUploaded(null); setError('')
    textarea.current?.focus()
  }
  function paste(event: ClipboardEvent) {
    const image = [...event.clipboardData.items].find(item => item.type.startsWith('image/'))
    if (image) { event.preventDefault(); pick(image.getAsFile()) }
  }
  async function submit() {
    if (!connected || pending.current) return
    const controller = new AbortController(); pending.current = controller
    setBusy(true); onBusyChange(true); setError('')
    try {
      let image = uploaded
      if (file && !image) {
        image = await uploadSessionImage(targetId, sessionId, file, controller.signal)
        if (!alive.current) return
        setUploaded(image)
      }
      // Running tmux sessions already received the reference from the upload endpoint.
      const data = image ? `${image.injected ? '' : image.reference}${text ? ` ${text}` : ''}` : text
      await onSend(data)
      if (!alive.current) return
      setText(''); clearImage()
    } catch (failure) {
      if (alive.current) setError((failure as Error).message)
    } finally {
      pending.current = null
      if (alive.current) { setBusy(false); onBusyChange(false) }
    }
  }
  return <div className="terminal-composer">
    {preview && <div className="terminal-image-preview">
      <img src={preview} alt="Terminal image preview" />
      <span>{file!.name}</span>
      <button type="button" className="icon-button" aria-label="Remove image" disabled={busy} onClick={() => { clearImage(); setError('') }}><X size={18} /></button>
    </div>}
    {error && <p className="error" role="alert">{error}</p>}
    <form className="terminal-compose" aria-busy={busy} onSubmit={event => { event.preventDefault(); void submit() }}>
      <input ref={chooser} type="file" aria-label="Choose terminal image" accept={imageMediaTypes.join(',')} hidden disabled={!connected || busy} onChange={event => { pick(event.target.files?.[0]); event.target.value = '' }} />
      <button type="button" className="button secondary terminal-image-button" aria-label="Attach image" title="Attach image" disabled={!connected || busy} onClick={() => chooser.current?.click()}><ImagePlus size={18} /></button>
      <textarea ref={textarea} aria-label="Terminal text" aria-description="Enter adds a line. Ctrl or Command plus Enter sends. Paste an image to attach it." placeholder="Type or paste text…" value={text} rows={1} autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={8000} disabled={busy} enterKeyHint="enter" onPaste={paste} onChange={event => { setText(event.target.value); setError('') }} onKeyDown={event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() }
      }} />
      <button className="button secondary" disabled={!connected || busy} type="submit">{busy ? <><LoaderCircle className="loading-spinner" size={16} /> Sending…</> : 'Send'}</button>
    </form>
  </div>
}
