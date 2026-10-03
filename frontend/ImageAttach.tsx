import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { Check, Circle, Copy, ImagePlus, LoaderCircle } from 'lucide-react'
import type { Session, SessionImage, SessionImageInput } from '../shared/session-manager'
import { codingToolLabels, imageMediaTypes, maxImageBytes } from '../shared/session-manager'
import { api } from './api'
import { Modal } from './ui'

const mediaTypes = new Set<string>(imageMediaTypes)

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Could not read the image file'))
    reader.readAsDataURL(file)
  })
}

export default function ImageAttach({
  targetId,
  session,
  onClose,
}: {
  targetId: string
  session: Session
  onClose: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<SessionImage | null>(null)
  const [copied, setCopied] = useState(false)
  const zone = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    zone.current?.focus()
  }, [])
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview)
    },
    [preview],
  )
  function pick(candidate: File | null | undefined) {
    if (busy || !candidate) return
    setResult(null)
    setCopied(false)
    setFile(null)
    setPreview('')
    if (!mediaTypes.has(candidate.type)) {
      setError('That is not a PNG, JPEG, GIF, or WebP image.')
      return
    }
    if (!candidate.size || candidate.size > maxImageBytes) {
      setError('Images are limited to 16 MB.')
      return
    }
    setError('')
    setFile(candidate)
    setPreview(URL.createObjectURL(candidate))
  }
  function onPaste(event: ClipboardEvent) {
    const item = [...event.clipboardData.items].find((entry) => entry.type.startsWith('image/'))
    if (item) {
      event.preventDefault()
      pick(item.getAsFile())
    }
  }
  function onDrop(event: DragEvent) {
    event.preventDefault()
    pick(event.dataTransfer.files?.[0])
  }
  async function upload() {
    if (!file) return
    setBusy(true)
    setError('')
    try {
      const dataUrl = await readFile(file)
      setResult(
        await api<SessionImage>(`/targets/${targetId}/sessions/${session.id}/image`, 'POST', {
          data: dataUrl.slice(dataUrl.indexOf(',') + 1),
          mediaType: file.type as SessionImageInput['mediaType'],
        }),
      )
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path)
      setCopied(true)
    } catch {
      setCopied(false)
      setError('Could not copy the reference. Select it and copy it manually.')
    }
  }
  return (
    <Modal
      title={`Attach an image to ${session.name}`}
      subtitle="Upload an image to this target. Running tmux sessions receive its file path; other sessions offer a reference to copy into your terminal."
      closeDisabled={busy}
      onClose={onClose}
    >
      {result ? (
        <div className="image-result">
          {result.injected ? (
            <p role="status">
              <Check size={16} /> The image reference was pasted into the session input.
              Switch to your terminal and send it to {codingToolLabels[session.tool]}.
            </p>
          ) : (
            <>
              <p role="status">
                The image was saved on the target. Automatic paste is unavailable for this session.
                Copy this reference into your terminal:
              </p>
              <div className="command-box">
                <div>
                  <span>
                    <Circle className="status-indicator" size={6} fill="currentColor" strokeWidth={0} aria-hidden="true" /> IMAGE ON TARGET
                  </span>
                  <button className="copy-button" onClick={() => void copyPath(result.reference)}>
                    {copied ? <Check /> : <Copy />}
                    {copied ? 'Copied' : 'Copy reference'}
                  </button>
                </div>
                <code>{result.reference}</code>
              </div>
            </>
          )}
        </div>
      ) : (
        <>
          <div
            ref={zone}
            className="paste-zone"
            tabIndex={0}
            role="group"
            aria-label="Paste an image from the clipboard"
            onPaste={onPaste}
            onDrop={onDrop}
            onDragOver={(event) => event.preventDefault()}
          >
            {preview ? (
              <img className="paste-preview" src={preview} alt="Clipboard image preview" />
            ) : (
              <p>
                <ImagePlus size={22} /> Paste an image here or drop an image file.
                <span>PNG, JPEG, GIF, or WebP · up to 16 MB</span>
              </p>
            )}
          </div>
          <input
            ref={input}
            type="file"
            aria-label="Choose image file"
            accept={imageMediaTypes.join(',')}
            hidden
            disabled={busy}
            onChange={(event) => {
              pick(event.target.files?.[0])
              event.target.value = ''
            }}
          />
          <button className="button secondary image-browse" disabled={busy} onClick={() => input.current?.click()}>
            Browse images
          </button>
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="modal-actions">
        {result ? (
          <button className="button primary" onClick={onClose}>Done</button>
        ) : (
          <>
            <button className="button secondary" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button className="button primary" disabled={!file || busy} onClick={() => void upload()}>
              {busy ? <LoaderCircle className="loading-spinner" /> : <ImagePlus />}
              {busy ? 'Uploading…' : 'Send to session'}
            </button>
          </>
        )}
      </div>
    </Modal>
  )
}
