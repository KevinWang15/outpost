import { useEffect, useState } from 'react'
import type { FileViewerBridge } from '../../shared/sessionFiles'
import { FileViewer } from '../terminal/FileViewer'
import { SessionFiles } from '../terminal/sessionFiles'
import { useSessionFiles } from '../terminal/useSessionFiles'

declare global {
  interface Window {
    outpostFileViewer: FileViewerBridge
  }
}
const bridge = window.outpostFileViewer

export default function FileViewerPage() {
  const [access] = useState(() => new SessionFiles('', bridge))
  const state = useSessionFiles(access, true)
  const [selected, setSelected] = useState<string | null>(null)
  const { setError } = state
  useEffect(() => {
    let active = true
    void bridge
      .selection()
      .then(id => {
        if (active) setSelected(id)
      })
      .catch(error => {
        if (active) setError((error as Error).message)
      })
    return () => {
      active = false
    }
  }, [setError])
  return selected !== null ? (
    <FileViewer selected={selected} access={access} state={state} close={bridge.close} />
  ) : (
    <div className="file-viewer-message" role="status">
      {state.error || 'Opening viewer…'}
      <button className="button" onClick={bridge.close}>
        Close
      </button>
    </div>
  )
}
