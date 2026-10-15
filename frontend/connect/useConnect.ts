import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session, Target } from '../../shared/model'
import { pagePaths } from '../../shared/pages'
import type { ConnectResponse, ConnectionStatus } from '../../shared/protocol'
import type { TerminalChoice } from '../../shared/terminals'
import { api } from '../api'
import { standaloneBrowser } from '../browser'
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

interface ConnectionAttempt extends ConnectionState {
  showDialog: boolean
}

/** Explicit and remembered choices share one launch path, invoked from the click gesture. */
export function useConnect(target: Target, onClose: () => void) {
  const [connection, setConnection] = useState<ConnectionAttempt | null>(null)
  const pending = useRef<AbortController | null>(null)
  const toast = useToast()
  const close = useCallback(() => {
    pending.current?.abort()
    setConnection(null)
    onClose()
  }, [onClose])

  useEffect(() => () => pending.current?.abort(), [])

  async function launch(session: Session, terminal: TerminalChoice, showDialog = true) {
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setConnection({ session, phase: { kind: 'requesting', terminal }, error: '', showDialog })
    try {
      if (terminal === 'web') {
        const query = new URLSearchParams({
          target: target.id,
          session: session.id,
          title: `${session.name} · ${target.name}`,
        })
        const url = `${pagePaths.terminal}?${query}`
        if (standaloneBrowser()) {
          window.location.assign(url)
          return
        }
        // Keep window.open synchronous with Connect, including when the chooser is skipped.
        const popup = window.open(url, '_blank', 'popup,width=1200,height=800')
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
      setConnection(current =>
        current && !controller.signal.aborted
          ? { ...current, phase: { kind: 'opening', id: result.id, slow: false } }
          : current,
      )
      window.location.assign(result.url)
    } catch (problem) {
      if (!controller.signal.aborted)
        setConnection({ session, phase: { kind: 'choose' }, error: (problem as Error).message, showDialog: true })
    }
  }

  function connect(session: Session) {
    // Read on every click so changes in other browser tabs take effect too.
    const terminal = preferredTerminal()
    if (terminal) void launch(session, terminal, false)
    else {
      pending.current?.abort()
      setConnection({ session, phase: { kind: 'choose' }, error: '', showDialog: true })
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
    setConnection(current => (current ? { ...current, phase: { kind: 'choose' }, error: '', showDialog: true } : null))
  }

  const phase = connection?.phase.kind
  const sessionId = connection?.session.id
  const openingId = connection?.phase.kind === 'opening' ? connection.phase.id : null
  useEffect(() => {
    if (phase !== 'requesting' && phase !== 'opening') return
    // Recover visibly even when a launch request or status poll is still waiting on the network.
    const timer = setTimeout(() => {
      setConnection(current =>
        current &&
        current.session.id === sessionId &&
        current.phase.kind === phase &&
        (current.phase.kind !== 'opening' || current.phase.id === openingId)
          ? {
              ...current,
              showDialog: true,
              phase: current.phase.kind === 'opening' ? { ...current.phase, slow: true } : current.phase,
            }
          : current,
      )
    }, 6000)
    return () => clearTimeout(timer)
  }, [phase, sessionId, openingId])

  useEffect(() => {
    if (!openingId) return
    const controller = new AbortController()
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
      timer = setTimeout(() => void poll(), 1000)
    }
    timer = setTimeout(() => void poll(), 1000)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [openingId])

  const showDialog = connection?.showDialog ?? false
  useEffect(() => {
    if (phase !== 'connected') return
    const timer = setTimeout(close, showDialog ? 1500 : 0)
    return () => clearTimeout(timer)
  }, [phase, showDialog, close])

  return { connection: showDialog ? connection : null, connect, choose, back, close }
}
