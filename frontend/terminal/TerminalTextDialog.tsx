import { useRef, useState } from 'react'
import { Dialog } from '../ui/Dialog'
import { desktop } from '../desktop'
import { touchInput } from '../browser'

export default function TerminalTextDialog({ text, onClose }: { text: string; onClose: () => void }) {
  const field = useRef<HTMLTextAreaElement>(null)
  const [status, setStatus] = useState('')
  const [selected, setSelected] = useState(false)
  async function copy() {
    const element = field.current!
    const value =
      element.selectionStart !== element.selectionEnd ? text.slice(element.selectionStart, element.selectionEnd) : text
    try {
      if (desktop) {
        if (!(await desktop.copyText(value))) throw new Error('Copy unavailable')
      } else await navigator.clipboard.writeText(value)
      setStatus('Copied')
    } catch {
      setStatus('Select the text and use Copy from its context menu.')
    }
  }
  return (
    <Dialog
      title="Select text"
      description={`A copy of the text currently on screen. The terminal keeps running. ${touchInput() ? 'Touch and hold' : 'Drag'} to select.`}
      className="terminal-text-dialog"
      size="large"
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>
            Done
          </button>
          <button
            className="button primary"
            disabled={!text}
            onMouseDown={event => event.preventDefault()}
            onClick={() => void copy()}
          >
            {selected ? 'Copy selection' : 'Copy all'}
          </button>
        </>
      }
    >
      <textarea
        ref={field}
        readOnly
        value={text}
        aria-label="Terminal text"
        spellCheck={false}
        onSelect={event => setSelected(event.currentTarget.selectionStart !== event.currentTarget.selectionEnd)}
      />
      {status && <p role="status">{status}</p>}
    </Dialog>
  )
}
