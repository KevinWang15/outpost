import { Download, LoaderCircle, Trash2 } from 'lucide-react'
import type { SessionFile } from '../../shared/sessionFiles'
import type { SessionFilesState } from './useSessionFiles'

export function FileActions({ file, state }: { file: SessionFile; state: SessionFilesState }) {
  return (
    <>
      <button
        className="icon-button"
        aria-label={`Download ${file.name}`}
        title="Download"
        disabled={!!state.busy}
        onClick={() => void state.act(file, false)}
      >
        {state.busy?.id === file.id && !state.busy.remove ? (
          <LoaderCircle className="spin" size={18} />
        ) : (
          <Download size={18} />
        )}
      </button>
      <button
        className="icon-button"
        aria-label={`Remove ${file.name}`}
        title="Remove from session (keeps the original file)"
        disabled={!!state.busy}
        onClick={() => void state.act(file, true)}
      >
        {state.busy?.id === file.id && state.busy.remove ? (
          <LoaderCircle className="spin" size={18} />
        ) : (
          <Trash2 size={18} />
        )}
      </button>
    </>
  )
}
