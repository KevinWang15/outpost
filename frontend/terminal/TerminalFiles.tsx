import { useEffect, useId, useRef, useState } from 'react'
import { Download, Files, LoaderCircle, RefreshCw, Trash2, X } from 'lucide-react'
import { previewImage, type SessionFile } from '../../shared/sessionFiles'
import { desktop } from '../desktop'
import { FilePreview, FileThumbnail } from './SessionFilePreview'
import { fileRequest, fileSize, listSessionFiles, sessionFileBlob } from './sessionFiles'

/** Overlay UI: list and preview never participate in xterm's geometry. */
export default function TerminalFiles({
  token,
  connected,
  revision,
  restoreFocus,
}: {
  token: string
  connected: boolean
  revision: number
  restoreFocus(): void
}) {
  const [files, setFiles] = useState<SessionFile[]>([])
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<SessionFile | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const transfer = useRef<AbortController | null>(null)
  const id = useId()
  useEffect(() => {
    if (!connected) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let loading = false
    const load = async () => {
      if (loading || controller.signal.aborted) return
      clearTimeout(timer)
      loading = true
      try {
        const next = await listSessionFiles(token, AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]))
        if (!controller.signal.aborted) {
          setFiles(previous => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next))
          setError('')
        }
      } catch (error) {
        if (!controller.signal.aborted) setError((error as Error).message)
      } finally {
        loading = false
        if (!controller.signal.aborted) timer = setTimeout(() => void load(), 30_000)
      }
    }
    const visible = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', visible)
    void load()
    return () => {
      controller.abort()
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [token, connected, revision, refresh])
  useEffect(() => () => transfer.current?.abort(), [])
  useEffect(() => {
    if (!open || preview) return
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, preview])

  const act = async (file: SessionFile, remove: boolean) => {
    if (transfer.current) return
    const controller = new AbortController()
    transfer.current = controller
    setBusy(file.id)
    setError('')
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
      if (remove) {
        await fileRequest(token, '/' + file.id, signal, 'DELETE')
        if (!controller.signal.aborted) {
          setFiles(previous => previous.filter(item => item.id !== file.id))
          setRefresh(value => value + 1)
          trigger.current?.focus()
        }
      } else if (desktop) {
        await desktop.downloadFile(file)
      } else {
        const blob = await sessionFileBlob(token, file, signal)
        if (controller.signal.aborted) return
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = file.name
        document.body.append(link)
        link.click()
        link.remove()
        // Retain until the browser has started the download.
        setTimeout(() => URL.revokeObjectURL(url), 30_000)
      }
    } catch (error) {
      if (!controller.signal.aborted) setError((error as Error).message)
    } finally {
      if (!controller.signal.aborted) setBusy(null)
      if (transfer.current === controller) transfer.current = null
    }
  }

  if (!files.length && !open) return null
  return (
    <div
      ref={container}
      className="terminal-files"
      onKeyDown={event => {
        event.stopPropagation()
        if (event.key === 'Escape' && !preview) {
          event.preventDefault()
          setOpen(false)
          restoreFocus()
        }
      }}
    >
      <button
        ref={trigger}
        className="terminal-files-badge icon-button"
        aria-label={`Session files (${files.length})`}
        aria-expanded={open}
        aria-controls={id}
        title="Session files"
        onClick={() => setOpen(value => !value)}
      >
        <Files size={18} />
        <span>{files.length}</span>
      </button>
      {open && (
        <section id={id} className="terminal-files-panel" aria-label="Session files">
          <header>
            <strong>
              Session files <small>{files.length}</small>
            </strong>
            <button
              className="icon-button"
              aria-label="Refresh files"
              disabled={!connected}
              onClick={() => setRefresh(value => value + 1)}
            >
              <RefreshCw size={15} />
            </button>
            <button
              className="icon-button"
              aria-label="Close files"
              onClick={() => {
                setOpen(false)
                restoreFocus()
              }}
            >
              <X size={17} />
            </button>
          </header>
          {!connected && <p className="terminal-files-message">Reconnecting. Files will refresh when connected.</p>}
          {error && (
            <p className="terminal-files-message" role="alert">
              {error}
            </p>
          )}
          <ul>
            {files.map(file => (
              <li key={file.id}>
                <button
                  className="terminal-file-details"
                  disabled={!previewImage(file)}
                  title={previewImage(file) ? `Preview ${file.name}` : file.name}
                  onClick={() => setPreview(file)}
                >
                  <FileThumbnail file={file} token={token} />
                  <span className="terminal-file-description">
                    <strong>{file.name}</strong>
                    <span>
                      <time dateTime={file.createdAt}>
                        {new Date(file.createdAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
                      </time>
                      <span>· {fileSize(file.size)}</span>
                    </span>
                  </span>
                </button>
                <button
                  className="icon-button"
                  aria-label={`Remove ${file.name}`}
                  title="Remove from session (keeps the original file)"
                  disabled={!!busy}
                  onClick={() => void act(file, true)}
                >
                  <Trash2 size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Download ${file.name}`}
                  title="Download"
                  disabled={!!busy}
                  onClick={() => void act(file, false)}
                >
                  {busy === file.id ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
                </button>
              </li>
            ))}
          </ul>
          {!files.length && <p className="terminal-files-message">No files in this session.</p>}
        </section>
      )}
      {preview && (
        <FilePreview
          key={preview.id}
          file={preview}
          token={token}
          close={() => {
            setPreview(null)
            trigger.current?.focus()
          }}
        />
      )}
    </div>
  )
}
