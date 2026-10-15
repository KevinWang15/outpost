import { useId, useState } from 'react'
import { terminalChoices, type TerminalChoice } from '../../shared/terminals'
import { Dialog } from '../ui/Dialog'
import { useToast } from '../ui/toast-context'
import { preferredTerminal, setPreferredTerminal } from './preference'

export default function ConnectionPreferences({ onClose }: { onClose: () => void }) {
  const [terminal, setTerminal] = useState<TerminalChoice | null>(preferredTerminal)
  const [error, setError] = useState('')
  const id = useId()
  const toast = useToast()

  function save() {
    try {
      setPreferredTerminal(terminal)
      toast(terminal ? 'Connection preference saved' : 'Connection choice cleared. Connect will ask every time.')
      onClose()
    } catch (problem) {
      setError((problem as Error).message)
    }
  }

  return (
    <Dialog
      title="Connection preferences"
      description="Applies to all sessions on this Outpost server in this browser."
      size="small"
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" onClick={save}>
            Save
          </button>
        </>
      }
    >
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <label className="field" htmlFor={id}>
        <span className="label">When I click Connect</span>
        <select
          id={id}
          value={terminal ?? ''}
          onChange={event => setTerminal(terminalChoices.find(choice => choice === event.target.value) ?? null)}
        >
          <option value="">Ask every time</option>
          <option value="web">Open Web terminal</option>
          <option value="desktop">Open Outpost Desktop</option>
        </select>
        <small>Choose “Ask every time” to clear your remembered choice.</small>
      </label>
    </Dialog>
  )
}
