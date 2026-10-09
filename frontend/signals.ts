import { signalIdentity, type SessionSignal } from '../shared/signals'
import { api } from './api'

/** Each window registers its capabilities. Recipient selection lives on the
 * server, so tabs, browser profiles and SSE reconnects cannot race to open. */
export function listenForSignals(handlers: ReadonlyMap<string, (event: SessionSignal) => void>) {
  const id = crypto.randomUUID()
  const query = new URLSearchParams({ id, types: [...handlers.keys()].join(',') })
  const source = new EventSource(`/api/signals/events?${query}`)
  const seen = new Set<string>()
  const activity = () => {
    if (source.readyState === EventSource.OPEN) void api(`/signals/listeners/${id}/activity`, 'POST', {
      focused: document.hasFocus(), visible: document.visibilityState === 'visible',
    }).catch(() => {})
  }
  source.onopen = activity
  source.addEventListener('signal', event => {
    if (event.data.length > 64 * 1024) return
    let signal: SessionSignal
    try { signal = JSON.parse(event.data) } catch { return }
    if (!signal || signal.version !== 1 || typeof signal.id !== 'string' || seen.has(signalIdentity(signal))) return
    const handler = handlers.get(signal.type)
    if (!handler) return
    seen.add(signalIdentity(signal))
    if (seen.size > 10000) seen.delete(seen.values().next().value!)
    handler(signal)
  })
  window.addEventListener('focus', activity); window.addEventListener('blur', activity)
  document.addEventListener('visibilitychange', activity)
  return () => {
    source.close()
    window.removeEventListener('focus', activity); window.removeEventListener('blur', activity)
    document.removeEventListener('visibilitychange', activity)
  }
}
