import { useCallback, useState } from 'react'
import type { Session, Target } from '../../shared/model'
import { pagePaths } from '../../shared/pages'
import type { TerminalChoice } from '../../shared/terminals'
import { standaloneBrowser } from '../browser'
import { useDesktopEntry } from '../desktop/useDesktopEntry'
import { useToast } from '../ui/toast-context'
import { preferredTerminal, setPreferredTerminal } from './preference'

export interface ConnectionState {
  session: Session
  phase: 'choose' | 'opening'
  error: string
}

/** The chooser launches a browser page or an OS intent. Each destination owns
 * authentication and connection; no network request belongs in this chooser. */
export function useConnect(target: Target, onClose: () => void) {
  const [connection, setConnection] = useState<ConnectionState | null>(null)
  const openDesktop = useDesktopEntry()
  const toast = useToast()
  const close = useCallback(() => {
    setConnection(null)
    onClose()
  }, [onClose])

  function launch(session: Session, terminal: TerminalChoice, showDialog = true) {
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
      openDesktop({ targetId: target.id, sessionId: session.id })
      if (showDialog) setConnection({ session, phase: 'opening', error: '' })
      else close()
    } catch (problem) {
      setConnection({ session, phase: 'choose', error: (problem as Error).message })
    }
  }
  function connect(session: Session) {
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
    setConnection(current => (current ? { ...current, phase: 'choose', error: '' } : null))
  }
  return { connection, connect, choose, back, close }
}
