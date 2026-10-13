import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session, SessionList } from '../../shared/model'
import { api } from '../api'

/** Live sessions for one target. Sessions are always read from the target;
 * a failed read shows the error rather than an old list. */
export function useSessions(targetId: string) {
  const [sessions, setSessions] = useState<Session[] | null>(null)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(true)
  const request = useRef<AbortController | null>(null)
  const refresh = useCallback(
    async (quiet = false) => {
      // Polls wait for a running request; explicit refreshes replace it.
      if (quiet && request.current) return
      request.current?.abort()
      const controller = new AbortController()
      request.current = controller
      if (!quiet) setRefreshing(true)
      try {
        const result = await api<SessionList>(`/targets/${targetId}/sessions`, 'GET', undefined, controller.signal)
        if (!controller.signal.aborted) {
          setSessions(result.sessions)
          setError('')
        }
      } catch (problem) {
        if (!controller.signal.aborted) {
          setSessions([])
          setError((problem as Error).message)
        }
      } finally {
        if (request.current === controller) {
          request.current = null
          setRefreshing(false)
        }
      }
    },
    [targetId],
  )
  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0)
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(true)
    }, 10_000)
    return () => {
      clearTimeout(initial)
      clearInterval(timer)
      request.current?.abort()
      request.current = null
    }
  }, [refresh])
  return { sessions, error, refreshing, refresh }
}
