import { useCallback, useEffect, useRef, useState } from 'react'
import type { SoftwareReport } from '../../shared/model'
import { api } from '../api'

/** Live software inspection; installations poll their status, then inspect again. */
export function useSoftware(targetId: string, requirementsKey: string) {
  const [report, setReport] = useState<SoftwareReport | null>(null)
  const [checking, setChecking] = useState(true),
    [error, setError] = useState('')
  const pending = useRef<AbortController | null>(null),
    mounted = useRef(false)
  const refresh = useCallback(async () => {
    if (!mounted.current) return
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setChecking(true)
    setError('')
    try {
      const result = await api<SoftwareReport>(
        `/targets/${targetId}/software`,
        'GET',
        undefined,
        controller.signal,
      )
      if (!controller.signal.aborted) setReport(result)
    } catch (error) {
      if (!controller.signal.aborted) setError((error as Error).message)
    } finally {
      if (!controller.signal.aborted) setChecking(false)
    }
  }, [targetId])
  useEffect(() => {
    mounted.current = true
    let active = true
    queueMicrotask(() => {
      if (active) void refresh()
    })
    return () => {
      active = false
      mounted.current = false
      pending.current?.abort()
    }
  }, [refresh, requirementsKey])
  useEffect(() => {
    if (report?.installation?.status !== 'running') return
    // Poll job status only; once complete, inspect actual software again.
    const controller = new AbortController()
    const timer = setInterval(() => {
      api<{ installation: SoftwareReport['installation'] }>(
        `/targets/${targetId}/installations`,
        'GET',
        undefined,
        controller.signal,
      )
        .then((result) => {
          if (
            result.installation?.status !== 'running' &&
            !controller.signal.aborted
          )
            void refresh()
        })
        .catch(() => {
          if (!controller.signal.aborted) void refresh()
        })
    }, 2000)
    return () => {
      clearInterval(timer)
      controller.abort()
    }
  }, [targetId, report?.installation?.status, refresh])
  return { report, checking, error, refresh }
}
