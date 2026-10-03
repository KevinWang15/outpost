import { useCallback, useEffect, useRef, useState } from 'react'
import type { Connection, Session } from '../shared/session-manager'
import type { DesktopTerminal } from '../shared/terminals'
import { api } from './api'
import { terminalPreferences } from './terminals'

export type ConnectionMode = 'launch' | 'options'
export interface PendingConnection { sessionId: string; mode: ConnectionMode }

export function useSessionConnection(
  targetId: string,
  externalDialogOpen: boolean,
  onReady: (session: Session, connection: Connection) => void,
  onError: (message: string) => void,
) {
  const [connecting, setConnecting] = useState<PendingConnection | null>(null)
  const [notice, setNotice] = useState<{ id: number; message: string; tone: 'success' | 'warning' } | null>(null)
  const noticeId = useRef(0)
  const request = useRef<{ controller: AbortController; sessionId: string } | null>(null)
  const dismissNotice = useCallback(() => setNotice(null), [])
  const cancel = useCallback(() => {
    request.current?.controller.abort()
    request.current = null
    setConnecting(null)
    setNotice(null)
  }, [])
  // App-owned dialogs interrupt pending work just like switching targets does.
  useEffect(() => cancel, [targetId, externalDialogOpen, cancel])

  async function connect(session: Session, mode: ConnectionMode) {
    if (request.current?.sessionId === session.id) return
    cancel()
    const controller = new AbortController()
    const pending = { controller, sessionId: session.id }
    request.current = pending
    setConnecting({ sessionId: session.id, mode })
    onError('')
    try {
      if (mode === 'launch') {
        try {
          const terminal = await api<DesktopTerminal>(
            `/targets/${targetId}/sessions/${session.id}/launch`, 'POST', { preferences: terminalPreferences() }, controller.signal,
          )
          if (!controller.signal.aborted) {
            setNotice({ id: ++noticeId.current, tone: 'success', message: `Opening ${session.name} in ${terminal.name} on the manager computer.` })
          }
          return
        } catch (error) {
          if (controller.signal.aborted) return
          setNotice({ id: ++noticeId.current, tone: 'warning', message: `Could not open a terminal. ${(error as Error).message}` })
        }
      }
      const connection = await api<Connection>(
        `/targets/${targetId}/sessions/${session.id}/connect`, 'POST', undefined, controller.signal,
      )
      if (!controller.signal.aborted) onReady(session, connection)
    } catch (error) {
      if (!controller.signal.aborted) onError((error as Error).message)
    } finally {
      if (request.current === pending) {
        request.current = null
        setConnecting(null)
      }
    }
  }
  return { connecting, connect, cancel, notice, dismissNotice }
}
