import { useEffect, useRef, useState } from 'react'
import { File, Image, LoaderCircle, X } from 'lucide-react'
import { previewImage, type SessionFile } from '../../shared/sessionFiles'
import { fileSize, sessionFileBlob } from './sessionFiles'

// Thumbnail reads are serialized so opening the list cannot flood SSH or starve downloads.
let thumbnails: Promise<unknown> = Promise.resolve()
function thumbnailBlob(token: string, file: SessionFile, signal: AbortSignal) {
  const result = thumbnails.then(async () => {
    signal.throwIfAborted()
    const blob = await sessionFileBlob(token, file, signal)
    signal.throwIfAborted()
    const bitmap = await createImageBitmap(blob)
    try {
      const scale = Math.min(1, 88 / Math.max(bitmap.width, bitmap.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Image preview is unavailable.')
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      return await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          value => (value ? resolve(value) : reject(new Error('Could not create a thumbnail.'))),
          'image/png',
        ),
      )
    } finally {
      bitmap.close()
    }
  })
  thumbnails = result.then(
    () => {},
    () => {},
  )
  return result
}

/** Every object URL and fetch belongs to a mounted preview, never to the PTY. */
function useFileImage(file: SessionFile, token: string, enabled: boolean, thumbnail = false) {
  const { id, size, mediaType, name, createdAt } = file
  const [image, setImage] = useState({ id: '', token: '', url: '', error: '' })
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    let url = ''
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
    const load = thumbnail
      ? thumbnailBlob(token, { id, size, mediaType, name, createdAt }, signal)
      : sessionFileBlob(token, { id, size, mediaType }, signal)
    void load
      .then(blob => {
        if (controller.signal.aborted) return
        url = URL.createObjectURL(blob)
        setImage({ id, token, url, error: '' })
      })
      .catch(error => {
        if (!controller.signal.aborted) setImage({ id, token, url: '', error: (error as Error).message })
      })
    return () => {
      controller.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [enabled, id, size, mediaType, name, createdAt, token, thumbnail])
  return enabled && image.id === id && image.token === token ? image : { url: '', error: '' }
}

export function FileThumbnail({ file, token }: { file: SessionFile; token: string }) {
  const element = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const { url } = useFileImage(file, token, visible && previewImage(file), true)
  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return
      observer.disconnect()
      setVisible(true)
    })
    observer.observe(element.current!)
    return () => observer.disconnect()
  }, [])
  return (
    <span ref={element} className="terminal-file-thumbnail">
      {url ? <img src={url} alt="" /> : previewImage(file) ? <Image size={23} /> : <File size={23} />}
    </span>
  )
}

export function FilePreview({ file, token, close }: { file: SessionFile; token: string; close(): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const { url, error } = useFileImage(file, token, true)
  const [broken, setBroken] = useState(false)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  return (
    <dialog
      ref={dialog}
      className="terminal-file-preview"
      aria-label={`Preview ${file.name}`}
      onCancel={event => {
        event.preventDefault()
        close()
      }}
    >
      <header>
        <div>
          <strong>{file.name}</strong>
          <small>{fileSize(file.size)}</small>
        </div>
        <button className="icon-button" aria-label="Close preview" onClick={close} autoFocus>
          <X size={20} />
        </button>
      </header>
      <div className="terminal-file-preview-content">
        {error || broken ? (
          <p role="alert">{error || 'This image could not be previewed. You can still download it.'}</p>
        ) : url ? (
          <img src={url} alt={file.name} onError={() => setBroken(true)} />
        ) : (
          <LoaderCircle size={28} className="spin" aria-label="Loading preview" />
        )}
      </div>
    </dialog>
  )
}
