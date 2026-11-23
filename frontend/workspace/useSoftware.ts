import { useCallback, useEffect, useRef, useState } from 'react'
import type { Installation, SoftwareId, SoftwareReport } from '../../shared/model'
import { api } from '../api'

export function useSoftware(targetId: string, enabled = true) {
  const [report, setReport] = useState<SoftwareReport | null>(null)
  const [job, setJob] = useState<Installation | null>(null)
  const [checking, setChecking] = useState(true)
  const [error, setError] = useState('')
  const pending = useRef<AbortController | null>(null)
  const base = '/targets/' + targetId
  const refresh = useCallback(async () => {
    if (!enabled) return
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setChecking(true)
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
      if (!controller.signal.aborted) setReport(result)
    } catch (problem) {
      if (!controller.signal.aborted) setError((problem as Error).message)
    } finally {
      if (!controller.signal.aborted) setChecking(false)
    }
  }, [base, enabled])
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
