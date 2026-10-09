import { useEffect, useRef, useState } from 'react'
import { browserUrl, signalIdentity, type SessionSignal } from '../shared/signals'
import { listenForSignals } from './signals'
import { Modal } from './ui'

function openBrowser(url: string) {
  // noopener in windowFeatures always returns null, even on success. Open a
  // blank page first so we can detect blocking and sever opener before navigation.
  const tab = window.open('about:blank', '_blank')
  if (!tab) return false
  try { tab.opener = null; tab.location.replace(url); return true }
  catch { tab.close(); return false }
}

export default function BrowserSignals() {
  const [pending, setPending] = useState<{ id: string; url: string }[]>([])
  const [error, setError] = useState('')
  const completed = useRef<string | null>(null)
  useEffect(() => listenForSignals(new Map([['browser.open', (event: SessionSignal) => {
    let url: string
    try { url = browserUrl(event.payload) } catch { return }
    if (!openBrowser(url)) setPending(previous => [...previous, { id: signalIdentity(event), url }].slice(-50))
  }]])), [])
  const current = pending[0]
  if (!current) return null
  const dismiss = () => { setPending(previous => previous.filter(event => event.id !== current.id)); setError('') }
  const open = () => {
    if (completed.current === current.id) return
    if (openBrowser(current.url)) { completed.current = current.id; dismiss() }
    else setError('Your browser blocked the new tab. Allow popups for Outpost, then try again.')
  }
  return <Modal title="Open link from your terminal" subtitle="Your browser blocked the automatic popup. Open the link to continue." onClose={dismiss}>
    <p className="browser-signal-url">{current.url}</p>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="modal-actions">
      <button className="button secondary" onClick={dismiss}>Dismiss</button>
      <button className="button primary" onClick={open}>Open link</button>
    </div>
  </Modal>
}
