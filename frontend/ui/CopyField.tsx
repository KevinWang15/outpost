import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { copyText } from '../api'

export function CopyField({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  async function copy() {
    try {
      await copyText(value)
      setState('copied')
      setTimeout(() => setState('idle'), 2000)
    } catch {
      setState('failed')
    }
  }
  return (
    <div className="copy-field">
      <code aria-label={label}>{value}</code>
      <button className="button small" onClick={() => void copy()}>
        {state === 'copied' ? <Check size={14} /> : <Copy size={14} />}
        {state === 'copied' ? 'Copied' : 'Copy'}
      </button>
      {state === 'failed' && <small className="error">Clipboard unavailable. Select and copy the text.</small>}
    </div>
  )
}
