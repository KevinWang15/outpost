import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session, Target } from '../../shared/model'
import { pagePaths } from '../../shared/pages'
import type { ConnectResponse, ConnectionStatus } from '../../shared/protocol'
import type { TerminalChoice } from '../../shared/terminals'
import { api } from '../api'
import { useToast } from '../ui/toast-context'
import { preferredTerminal, setPreferredTerminal } from './preference'

type Phase =
  | { kind: 'choose' }
  | { kind: 'requesting'; terminal: TerminalChoice }
  | { kind: 'opening'; id: string; slow: boolean }
  | { kind: 'connected' }

export interface ConnectionState {
  session: Session
  phase: Phase
  error: string
}

/** Explicit and remembered choices share one launch path, invoked from the click gesture. */
export function useConnect(target: Target, onClose: () => void) {
  const [connection, setConnection] = useState<ConnectionState | null>(null)
  const pending = useRef<AbortController | null>(null)
  const toast = useToast()
  const close = useCallback(() => {
    pending.current?.abort()
    setConnection(null)
    onClose()
  }, [onClose])

  useEffect(() => () => pending.current?.abort(), [])

  async function launch(session: Session, terminal: TerminalChoice) {
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setConnection({ session, phase: { kind: 'requesting', terminal }, error: '' })
    try {
      if (terminal === 'web') {
        const query = new URLSearchParams({
          target: target.id,
          session: session.id,
          title: `${session.name} · ${target.name}`,
        })
        // Keep window.open synchronous with Connect, including when the chooser is skipped.
        const popup = window.open(`${pagePaths.terminal}?${query}`, '_blank', 'popup,width=1200,height=800')
        if (!popup) throw new Error('Allow pop-ups for Outpost, then try opening the web terminal again.')
        popup.opener = null
        close()
        return
      }
      const result = await api<ConnectResponse>(
        `/targets/${target.id}/sessions/${session.id}/connect`,
        'POST',
        { terminal },
        controller.signal,
      )
      if (controller.signal.aborted) return
      if (!result.url) throw new Error('Outpost did not return a desktop connection link. Please try again.')
      setConnection({ session, phase: { kind: 'opening', id: result.id, slow: false }, error: '' })
      window.location.assign(result.url)
    } catch (problem) {
      if (!controller.signal.aborted)
        setConnection({ session, phase: { kind: 'choose' }, error: (problem as Error).message })
    }
  }

  function connect(session: Session) {
    // Read on every click so changes in other browser tabs take effect too.
    const terminal = preferredTerminal()
    if (terminal) void launch(session, terminal)
    else {
      pending.current?.abort()
      setConnection({ session, phase: { kind: 'choose' }, error: '' })
    }
  }

  function choose(terminal: TerminalChoice, remember: boolean) {
    if (!connection) return
    try {
      setPreferredTerminal(remember ? terminal : null)
    } catch (problem) {
      // Storage failure must not prevent connecting or silently claim the preference was saved.
      toast((problem as Error).message, 'error')
    }
    void launch(connection.session, terminal)
  }

  function back() {
    pending.current?.abort()
    setConnection(current => (current ? { ...current, phase: { kind: 'choose' }, error: '' } : null))
  }

  const openingId = connection?.phase.kind === 'opening' ? connection.phase.id : null
  useEffect(() => {
    if (!openingId) return
    const controller = new AbortController()
    const started = Date.now()
    let timer: ReturnType<typeof setTimeout>
    const update = (phase: Phase) =>
      setConnection(current =>
        current?.phase.kind === 'opening' && current.phase.id === openingId ? { ...current, phase } : current,
      )
    const poll = async () => {
      try {
        const { status } = await api<ConnectionStatus>(`/connections/${openingId}`, 'GET', undefined, controller.signal)
        if (controller.signal.aborted) return
        if (status === 'connected') {
          update({ kind: 'connected' })
          return
        }
      } catch {
        // Retrying, choosing another terminal, and downloading remain available offline.
      }
      if (controller.signal.aborted) return
      if (Date.now() - started > 6000) update({ kind: 'opening', id: openingId, slow: true })
      timer = setTimeout(() => void poll(), 1000)
    }
    timer = setTimeout(() => void poll(), 1000)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [openingId])

  useEffect(() => {
    if (connection?.phase.kind !== 'connected') return
    const timer = setTimeout(close, 1500)
    return () => clearTimeout(timer)
  }, [connection?.phase.kind, close])

  return { connection, connect, choose, back, close }
}
