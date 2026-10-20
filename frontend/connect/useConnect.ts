import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session, Target } from '../../shared/model'
import { pagePaths } from '../../shared/pages'
import type { TerminalChoice } from '../../shared/terminals'
import { standaloneBrowser } from '../browser'
import { useDesktopEntry } from '../desktop/useDesktopEntry'
import { useToast } from '../ui/toast-context'
import { preferredTerminal, setPreferredTerminal } from './preference'
import { observeDesktopHandoff } from './desktopHandoff'

export interface ConnectionState {
  session: Session
  phase: 'choose' | 'desktop-help'
  error: string
}

/** The chooser launches a browser page or an OS intent. Each destination owns
 * authentication and connection; no network request belongs in this chooser. */
export function useConnect(target: Target, onClose: () => void) {
  const [connection, setConnection] = useState<ConnectionState | null>(null)
  const openDesktop = useDesktopEntry()
  const toast = useToast()
  const handoff = useRef<(() => void) | null>(null)
  const cancelHandoff = useCallback(() => {
    handoff.current?.()
    handoff.current = null
  }, [])
  useEffect(() => cancelHandoff, [cancelHandoff])
  const close = useCallback(() => {
    cancelHandoff()
    setConnection(null)
    onClose()
  }, [cancelHandoff, onClose])

  function launch(session: Session, terminal: TerminalChoice, showDialog = true) {
    cancelHandoff()
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
        const popup = window.open(url, '_blank', 'popup,width=1200,height=800')
        if (!popup) throw new Error('Allow pop-ups for Outpost, then try opening the web terminal again.')
        popup.opener = null
        close()
        return
      }
      setConnection(null)
      // Listen before the synchronous OS handoff so fast app launches cannot
      // leave a stale help dialog behind. Remembered choices remain dialog-free.
      if (showDialog)
        handoff.current = observeDesktopHandoff(close, () =>
          setConnection({ session, phase: 'desktop-help', error: '' }),
        )
      openDesktop({ targetId: target.id, sessionId: session.id })
      if (!showDialog) close()
    } catch (problem) {
      cancelHandoff()
      setConnection({ session, phase: 'choose', error: (problem as Error).message })
    }
  }
  function connect(session: Session) {
    cancelHandoff()
    const terminal = preferredTerminal()
    if (terminal) launch(session, terminal, false)
    else setConnection({ session, phase: 'choose', error: '' })
  }
  function choose(terminal: TerminalChoice, remember: boolean) {
    if (!connection) return
    try {
      setPreferredTerminal(remember ? terminal : null)
    } catch (error) {
      toast((error as Error).message, 'error')
    }
    launch(connection.session, terminal)
  }
  function back() {
    cancelHandoff()
    setConnection(current => (current ? { ...current, phase: 'choose', error: '' } : null))
  }
  return { connection, connect, choose, back, close }
}
