import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, File, LoaderCircle, X } from 'lucide-react'
import { previewImage, type SessionFile } from '../../shared/sessionFiles'
import { FileActions } from './FileActions'
import { useFileImage } from './useFileImage'
import { fileSize, type SessionFiles } from './sessionFiles'
import type { SessionFilesState } from './useSessionFiles'
import './file-viewer.scss'

function Preview({ file, access }: { file: SessionFile; access: SessionFiles }) {
  const supported = previewImage(file)
  const { url, error, retry } = useFileImage(file, access, supported)
  const [broken, setBroken] = useState(false)
  if (!supported)
    return (
      <div className="file-viewer-message">
        <File size={40} />
        <h2>Preview not supported</h2>
        <p>Download this file to open it in another app.</p>
      </div>
    )
  if (error || broken)
    return (
      <div className="file-viewer-message" role="alert">
        <p>{error || 'This image could not be previewed. You can still download it.'}</p>
        {error && (
          <button className="button" onClick={retry}>
            Retry preview
          </button>
        )}
      </div>
    )
  return url ? (
    <img src={url} alt={file.name} onError={() => setBroken(true)} />
  ) : (
    <LoaderCircle size={28} className="spin" aria-label="Loading preview" />
  )
}

/** The same window-filling viewer is used in browser dialogs and native modals. */
export function FileViewer({
  selected,
  access,
  state,
  close,
}: {
  selected: string
  access: SessionFiles
  state: SessionFilesState
  close(): void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [selection, setSelection] = useState({ id: selected, index: 0 })
  const found = state.files.findIndex(file => file.id === selection.id)
  const index = found >= 0 ? found : Math.min(selection.index, state.files.length - 1)
  const file = state.files[index]
  // On removal choose the next item at the same position, or the previous last
  // item. Track identity across inserts and refreshes rather than jumping by index.
  if (file && (file.id !== selection.id || index !== selection.index)) setSelection({ id: file.id, index })
  const move = (delta: number) => {
    if (!state.files.length) return
    const next = (index + delta + state.files.length) % state.files.length
    setSelection({ id: state.files[next].id, index: next })
  }
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])
  return (
    <dialog
      ref={dialog}
      className="file-viewer"
      aria-label="Session file viewer"
      onCancel={event => {
        event.preventDefault()
        close()
      }}
      onKeyDown={event => {
        event.stopPropagation()
        if (
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
        ) {
          event.preventDefault()
          move(event.key === 'ArrowLeft' ? -1 : 1)
        }
      }}
    >
      <header className="file-viewer-header">
        <div className="file-viewer-description" aria-live="polite">
          <strong title={file?.name}>{file?.name ?? 'Session files'}</strong>
          {file && (
            <small>
              <time dateTime={file.createdAt}>
                {new Date(file.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
              </time>
              <span> · {fileSize(file.size)}</span>
            </small>
          )}
        </div>
        <div className="file-viewer-actions">
          {file && <FileActions file={file} state={state} />}
          <button className="icon-button" aria-label="Close viewer" title="Close (Esc)" onClick={close} autoFocus>
            <X size={22} />
          </button>
        </div>
      </header>
      {state.error && (
        <div className="file-viewer-error" role="alert">
          {state.error}
          <button className="button" onClick={state.refresh}>
            Retry
          </button>
        </div>
      )}
      <div className="file-viewer-stage">
        <button
          className="file-viewer-nav icon-button"
          aria-label="Previous file"
          title="Previous file (←)"
          disabled={state.files.length < 2}
          onClick={() => move(-1)}
        >
          <ChevronLeft size={28} />
        </button>
        <div className="file-viewer-content">
          {file ? (
            <Preview key={file.id} file={file} access={access} />
          ) : state.loaded ? (
            <p>No files in this session.</p>
          ) : (
            !state.error && <LoaderCircle className="spin" size={28} aria-label="Loading files" />
          )}
        </div>
        <button
          className="file-viewer-nav icon-button"
          aria-label="Next file"
          title="Next file (→)"
          disabled={state.files.length < 2}
          onClick={() => move(1)}
        >
          <ChevronRight size={28} />
        </button>
      </div>
      <footer>
        {file ? `${index + 1} / ${state.files.length}` : '0 files'}
        <span>← → to browse · Esc to close</span>
      </footer>
    </dialog>
  )
}
