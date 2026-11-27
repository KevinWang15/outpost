import { useCallback, useEffect, useRef, useState } from 'react'
import type { Installation, SoftwareId, SoftwareReport } from '../../shared/model'
import { api } from '../api'
import { useAuth } from '../auth/useAuth'
import { getCachedSoftware, setCachedSoftware } from './cache'

export function useSoftware(targetId: string, enabled = true) {
  const { user } = useAuth()
  const accountKey = user?.id ?? 'local'
  const cached = enabled ? getCachedSoftware(accountKey, targetId) : null
  const [report, setReport] = useState<SoftwareReport | null>(cached)
  const [job, setJob] = useState<Installation | null>(null)
  const [checking, setChecking] = useState(!cached)
  const [error, setError] = useState('')
  const pending = useRef<AbortController | null>(null)
  const base = '/targets/' + targetId
  const refresh = useCallback(async () => {
    if (!enabled) return
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    if (!getCachedSoftware(accountKey, targetId)) setChecking(true)
    setError('')
    try {
      const { installation } = await api<{ installation: Installation | null }>(
        base + '/installations',
        'GET',
        undefined,
        controller.signal,
      )
      if (controller.signal.aborted) return
      setJob(installation)
      if (installation?.status === 'running') return
      const result = await api<SoftwareReport>(base + '/software', 'GET', undefined, controller.signal)
      if (!controller.signal.aborted) {
        setCachedSoftware(accountKey, targetId, result)
        setReport(result)
      }
    } catch (problem) {
      if (!controller.signal.aborted) setError((problem as Error).message)
    } finally {
      if (!controller.signal.aborted) setChecking(false)
    }
  }, [accountKey, base, enabled, targetId])
  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 0)
    return () => {
      clearTimeout(timer)
      pending.current?.abort()
    }
  }, [refresh])
  useEffect(() => {
    if (job?.status !== 'running') return
    const timer = setInterval(() => void refresh(), 2000)
    return () => clearInterval(timer)
  }, [job?.status, refresh])
  async function setup(software?: readonly SoftwareId[]) {
    setError('')
    try {
      setJob(await api<Installation>(base + '/installations', 'POST', software?.length ? { software } : {}))
      void refresh()
    } catch (problem) {
      setError((problem as Error).message)
    }
  }
  return { report, checking, error, refresh, setup, job }
}
