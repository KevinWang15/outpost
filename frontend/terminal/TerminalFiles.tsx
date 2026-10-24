import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Files, RefreshCw, X } from 'lucide-react'
import { desktop } from '../desktop'
import { FileThumbnail } from './FileThumbnail'
import { FileViewer } from './FileViewer'
import { FileActions } from './FileActions'
import { fileSize, SessionFiles } from './sessionFiles'
import { useSessionFiles } from './useSessionFiles'

/** Overlay UI: list and viewer never participate in xterm's geometry. */
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
  const access = useMemo(() => new SessionFiles(token, desktop?.files), [token])
  const [nativeViewing, setNativeViewing] = useState(false)
  const state = useSessionFiles(access, connected && !nativeViewing, revision)
  const { files, error } = state
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open || preview) return
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, preview])

  const view = (id: string) => {
    if (desktop) {
      if (nativeViewing) return
      setNativeViewing(true)
      void desktop
        .viewFiles(id)
        .then(() => {
          state.refresh()
          trigger.current?.focus()
        })
        .catch(error => state.setError((error as Error).message))
        .finally(() => setNativeViewing(false))
    } else setPreview(id)
  }
  if (!files.length && !open && !preview) return null
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
      {open && !nativeViewing && (
        <section id={id} className="terminal-files-panel" aria-label="Session files">
          <header>
            <strong>
              Session files <small>{files.length}</small>
            </strong>
            <button className="icon-button" aria-label="Refresh files" disabled={!connected} onClick={state.refresh}>
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
                <button className="terminal-file-details" title={`View ${file.name}`} onClick={() => view(file.id)}>
                  <FileThumbnail file={file} access={access} />
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
                <FileActions file={file} state={state} />
              </li>
            ))}
          </ul>
          {!files.length && <p className="terminal-files-message">No files in this session.</p>}
        </section>
      )}
      {preview && (
        <FileViewer
          selected={preview}
          access={access}
          state={state}
          close={() => {
            setPreview(null)
            trigger.current?.focus()
          }}
        />
      )}
    </div>
  )
}
