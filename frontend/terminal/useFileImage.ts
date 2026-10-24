import { useEffect, useState } from 'react'
import type { SessionFile } from '../../shared/sessionFiles'
import type { SessionFiles } from './sessionFiles'

/** URLs belong to their displayed image; original bytes belong to the session cache. */
export function useFileImage(file: SessionFile, access: SessionFiles, enabled: boolean, thumbnail = false) {
  const { id, size, mediaType, name, createdAt } = file
  const [attempt, setAttempt] = useState(0)
  const [image, setImage] = useState({ id: '', access, attempt, url: '', error: '' })
  useEffect(() => {
    if (!enabled) return
    let active = true
    let url = ''
    const selected = { id, size, mediaType, name, createdAt }
    const load = thumbnail ? access.thumbnails.read(selected) : access.read(selected)
    void load
      .then(blob => {
        if (!active) return
        url = URL.createObjectURL(blob)
        setImage({ id, access, attempt, url, error: '' })
      })
      .catch(error => {
        if (active) setImage({ id, access, attempt, url: '', error: (error as Error).message })
      })
    return () => {
      active = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [enabled, id, size, mediaType, name, createdAt, access, thumbnail, attempt])
  const current =
    enabled && image.id === id && image.access === access && image.attempt === attempt ? image : { url: '', error: '' }
  return { ...current, retry: () => setAttempt(value => value + 1) }
}
