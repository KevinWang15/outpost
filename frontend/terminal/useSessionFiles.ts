import { useEffect, useRef, useState } from 'react'
import type { SessionFile } from '../../shared/sessionFiles'
import type { SessionFiles } from './sessionFiles'

/** Shared list reconciliation and actions for the dropdown and native viewer. */
export function useSessionFiles(access: SessionFiles, connected: boolean, revision = 0) {
  const [files, setFiles] = useState<SessionFile[]>([])
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState<{ id: string; remove: boolean } | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const transfer = useRef<AbortController | null>(null)
  const mutation = useRef(0)
  useEffect(() => {
    if (!connected) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let loading = false
    const load = async () => {
      if (loading || controller.signal.aborted) return
      clearTimeout(timer)
      loading = true
      const generation = mutation.current
      try {
        const next = await access.list(AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]))
        if (!controller.signal.aborted && generation === mutation.current) {
          access.retain(next)
          setFiles(previous => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next))
          setLoaded(true)
          setLoadError('')
        }
      } catch (error) {
        if (!controller.signal.aborted) setLoadError((error as Error).message)
      } finally {
        loading = false
        if (!controller.signal.aborted) timer = setTimeout(() => void load(), 30_000)
      }
    }
    const visible = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', visible)
    void load()
    return () => {
      controller.abort()
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [access, connected, revision, refresh])
  useEffect(
    () => () => {
      transfer.current?.abort()
      access.clear()
    },
    [access],
  )

  const act = async (file: SessionFile, remove: boolean) => {
    if (transfer.current) return
    const controller = new AbortController()
    transfer.current = controller
    setBusy({ id: file.id, remove })
    setError('')
    try {
      if (remove) {
        await access.remove(file.id, AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]))
        if (!controller.signal.aborted) {
          mutation.current++
          setFiles(previous => previous.filter(item => item.id !== file.id))
          setRefresh(value => value + 1)
        }
      } else await access.download(file)
    } catch (error) {
      if (!controller.signal.aborted) setError((error as Error).message)
    } finally {
      if (!controller.signal.aborted) setBusy(null)
      if (transfer.current === controller) transfer.current = null
    }
  }
  return {
    files,
    loaded,
    error: error || loadError,
    busy,
    act,
    refresh: () => {
      setError('')
      setRefresh(value => value + 1)
    },
    setError,
  }
}
export type SessionFilesState = ReturnType<typeof useSessionFiles>
