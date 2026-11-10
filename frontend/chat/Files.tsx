// Files a session's agent published (Outpost MCP publish_file). They are stored
// on the session's target, as in terminal mode; chat reads them with its grant.
import { useContext, useEffect, useRef } from 'react'
import { Download, Files, X } from 'lucide-react'
import type { SessionFile } from '../../shared/sessionFiles'
import { FileActions } from '../terminal/FileActions'
import { FileThumbnail } from '../terminal/FileThumbnail'
import { FileViewer } from '../terminal/FileViewer'
import { fileSize, type SessionFiles } from '../terminal/sessionFiles'
import { useSessionFiles, type SessionFilesState } from '../terminal/useSessionFiles'
import { ConversationContext } from './context'

/** A published file where its turn or channel message shows it. */
export function FileCard({
  file,
  access,
  removed = false,
  onOpen,
}: {
  file: SessionFile
  access: SessionFiles
  removed?: boolean
  onOpen(id: string): void
}) {
  return (
    <div className={`file-card ${removed ? 'removed' : ''}`}>
      <button
        className="file-card-open"
        disabled={removed}
        aria-label={removed ? `${file.name}, removed` : `View ${file.name}`}
        title={removed ? 'Removed from the session' : `View ${file.name}`}
        onClick={() => onOpen(file.id)}
      >
        <FileThumbnail file={file} access={access} className="file-card-thumbnail" />
        <span>
          <strong>{file.name}</strong>
          <small>{removed ? 'Removed' : fileSize(file.size)}</small>
        </span>
      </button>
      {!removed && (
        <button
          className="icon-button"
          aria-label={`Download ${file.name}`}
          title="Download"
          onClick={() => void access.download(file)}
        >
          <Download size={16} />
        </button>
      )}
    </div>
  )
}

/** A file item in a session's transcript. */
export function TurnFile({ file }: { file: SessionFile }) {
  const { files } = useContext(ConversationContext)
  if (!files) return null
  return (
    <FileCard
      file={file}
      access={files.access}
      removed={files.state.loaded && !files.state.files.some(item => item.id === file.id)}
      onOpen={files.open}
    />
  )
}

/** The session's files, beside its conversation. */
export function FilesPanel({
  access,
  state,
  onOpen,
  onClose,
}: {
  access: SessionFiles
  state: SessionFilesState
  onOpen(id: string): void
  onClose(): void
}) {
  const panel = useRef<HTMLElement>(null)
  useEffect(() => panel.current?.focus(), [])
  return (
    <aside
      ref={panel}
      className="files-panel"
      aria-label="Session files"
      tabIndex={-1}
      onKeyDown={event => event.key === 'Escape' && onClose()}
    >
      <header>
        <Files size={16} />
        <strong>Files</strong>
        <span className="muted">{state.files.length}</span>
        <button className="icon-button" aria-label="Close files" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      <ul>
        {state.files.map(file => (
          <li key={file.id}>
            <button
              className="file-card-open"
              aria-label={`View ${file.name}`}
              title={`View ${file.name}`}
              onClick={() => onOpen(file.id)}
            >
              <FileThumbnail file={file} access={access} className="file-card-thumbnail" />
              <span>
                <strong>{file.name}</strong>
                <small>
                  {new Date(file.createdAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })} ·{' '}
                  {fileSize(file.size)}
                </small>
              </span>
            </button>
            <FileActions file={file} state={state} />
          </li>
        ))}
      </ul>
      {state.loaded && !state.files.length && (
        <p className="muted files-empty">
          Files the agent publishes appear here. Ask it to share a file, or it can use Outpost’s publish_file tool.
        </p>
      )}
    </aside>
  )
}

/** A viewer for one session's files, from anywhere that shows one of them. */
export function SessionFileViewer({
  access,
  selected,
  onClose,
}: {
  access: SessionFiles
  selected: string
  onClose(): void
}) {
  const state = useSessionFiles(access, true)
  return <FileViewer selected={selected} access={access} state={state} close={onClose} />
}
