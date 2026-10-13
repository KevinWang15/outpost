import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { Check, ImagePlus } from 'lucide-react'
import type { ImageMediaType, Session, SessionImage } from '../../shared/model'
import { imageMediaTypes } from '../../shared/model'
import { api, readImage } from '../api'
import { CopyField } from '../ui/CopyField'
import { Dialog } from '../ui/Dialog'
import { imageProblem } from '../terminal/clipboard'

/** Send an image to a session without opening a terminal. Running sessions get its path pasted once. */
export default function ImageDialog({ targetId, session, onClose }: { targetId: string; session: Session; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null), [preview, setPreview] = useState('')
  const [result, setResult] = useState<SessionImage | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const zone = useRef<HTMLDivElement>(null), chooser = useRef<HTMLInputElement>(null)
  useEffect(() => { zone.current?.focus() }, [])
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])
  function pick(candidate: File | null | undefined) {
    if (busy || !candidate) return
    const problem = imageProblem(candidate)
    setError(problem ?? ''); setResult(null)
    if (problem) return
    setFile(candidate); setPreview(URL.createObjectURL(candidate))
  }
  async function send() {
    if (!file) return
    setBusy(true); setError('')
    try { setResult(await api<SessionImage>(`/targets/${targetId}/sessions/${session.id}/image`, 'POST', { data: await readImage(file), mediaType: file.type as ImageMediaType })) }
    catch (problem) { setError((problem as Error).message) }
    finally { setBusy(false) }
  }
  return <Dialog title={`Send an image to ${session.name}`} busy={busy} onClose={onClose}
    description="In a terminal you can also paste images directly."
    footer={result ? <button className="button primary" onClick={onClose}>Done</button> : <>
      <button className="button" disabled={busy} onClick={onClose}>Cancel</button>
      <button className="button primary" disabled={!file || busy} onClick={() => void send()}>{busy ? 'Sending…' : 'Send image'}</button>
    </>}>
    {result ? result.injected
      ? <p className="success" role="status"><Check size={16} />The image path was pasted into the session. Switch to your terminal to send it.</p>
      : <><p role="status">The image was saved on the target. The session is not running, so copy its path into your prompt:</p><CopyField value={result.reference} label="Image path" /></>
      : <>
        <div ref={zone} className="drop-zone" tabIndex={0} role="group" aria-label="Paste or drop an image"
          onPaste={(event: ClipboardEvent) => {
            const item = [...event.clipboardData.items].find(entry => entry.type.startsWith('image/'))
            if (item) { event.preventDefault(); pick(item.getAsFile()) }
          }}
          onDrop={(event: DragEvent) => { event.preventDefault(); pick(event.dataTransfer.files?.[0]) }}
          onDragOver={event => event.preventDefault()}
          onClick={() => chooser.current?.click()}>
          {preview ? <img src={preview} alt="Selected image" /> : <p><ImagePlus size={22} />Paste, drop, or click to choose an image<small>PNG, JPEG, GIF or WebP · up to 16 MB</small></p>}
        </div>
        <input ref={chooser} type="file" hidden accept={imageMediaTypes.join(',')} onChange={event => { pick(event.target.files?.[0]); event.target.value = '' }} />
      </>}
    {error && <p className="error" role="alert">{error}</p>}
  </Dialog>
}
