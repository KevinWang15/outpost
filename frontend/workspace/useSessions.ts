import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session } from '../../shared/model'
import { api } from '../api'
import { useAuth } from '../auth/useAuth'
import { deleteCachedSessions, getCachedSessions, setCachedSessions } from './cache'

/** Live sessions for one target. Seeds from account cache for instant return visits,
 * revalidates immediately, and clears the cached list on error rather than showing stale data. */
export function useSessions(targetId: string, enabled = true) {
  const { user } = useAuth()
  const accountKey = user?.id ?? 'local'
  const cached = enabled ? getCachedSessions(accountKey, targetId) : null
  const [sessions, setSessions] = useState<Session[] | null>(cached)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(!cached)
  const request = useRef<AbortController | null>(null)
  const refresh = useCallback(
    async (quiet = false) => {
      if (!enabled) return
      // Polls wait for a running request; explicit refreshes replace it.
      if (quiet && request.current) return
      request.current?.abort()
      const controller = new AbortController()
      request.current = controller
      if (!quiet) setRefreshing(true)
      try {
        const result = await api<{ sessions: Session[] }>(
          `/targets/${targetId}/sessions`,
          'GET',
          undefined,
          controller.signal,
        )
        if (!controller.signal.aborted) {
          setCachedSessions(accountKey, targetId, result.sessions)
          setSessions(result.sessions)
          setError('')
        }
      } catch (problem) {
        if (!controller.signal.aborted) {
          deleteCachedSessions(accountKey, targetId)
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
    [accountKey, targetId, enabled],
  )
  useEffect(() => {
    const initial = setTimeout(() => void refresh(Boolean(getCachedSessions(accountKey, targetId))), 0)
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(true)
    }, 10_000)
    return () => {
      clearTimeout(initial)
      clearInterval(timer)
      request.current?.abort()
      request.current = null
    }
  }, [accountKey, targetId, refresh])
  return { sessions, error, refreshing, refresh }
}
