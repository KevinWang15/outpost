import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session, SessionList } from '../shared/session-manager'
import { api } from './api'

export function useLiveSessions(targetId: string) {
  const [sessions, setSessions] = useState<Session[]>([]),
    [registryPath, setRegistryPath] = useState('')
  const [sessionLoadError, setSessionLoadError] = useState(''),
    [refreshing, setRefreshing] = useState(true)
  const mounted = useRef(false),
    requestNumber = useRef(0)
  const sessionRequest = useRef<AbortController | null>(null)
  const refresh = useCallback(
    async (quiet = false) => {
      if (!mounted.current) return
      // Polls may wait, but every explicit refresh replaces any older request.
      if (quiet && sessionRequest.current) return
      sessionRequest.current?.abort()
      const controller = new AbortController()
      sessionRequest.current = controller
      const number = ++requestNumber.current
      if (!quiet) {
        setSessions([])
        setRegistryPath('')
        setSessionLoadError('')
        setRefreshing(true)
      }
      try {
        const result = await api<SessionList>(
          `/targets/${targetId}/sessions`,
          'GET',
          undefined,
          controller.signal,
        )
        if (requestNumber.current === number && !controller.signal.aborted) {
          setSessions(result.sessions)
          setRegistryPath(result.registryPath)
          setSessionLoadError('')
        }
      } catch (error) {
        if (requestNumber.current === number && !controller.signal.aborted) {
          setSessions([])
          setRegistryPath('')
          setSessionLoadError((error as Error).message)
        }
      } finally {
        if (sessionRequest.current === controller) sessionRequest.current = null
        if (requestNumber.current === number && !controller.signal.aborted) setRefreshing(false)
      }
    },
    [targetId],
  )
  useEffect(() => {
    mounted.current = true
    let active = true
    const initial = setTimeout(() => {
      if (active) void refresh()
    }, 0)
    const timer = setInterval(() => {
      if (active) void refresh(true)
    }, 10_000)
    return () => {
      mounted.current = false
      active = false
      clearTimeout(initial)
      clearInterval(timer)
      sessionRequest.current?.abort()
    }
  }, [targetId, refresh])
  return { sessions, registryPath, sessionLoadError, refreshing, refresh }
}
