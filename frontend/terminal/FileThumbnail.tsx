import { useEffect, useRef, useState } from 'react'
import { File, Image } from 'lucide-react'
import { previewImage, type SessionFile } from '../../shared/sessionFiles'
import type { SessionFiles } from './sessionFiles'
import { useFileImage } from './useFileImage'

export function FileThumbnail({ file, access }: { file: SessionFile; access: SessionFiles }) {
  const element = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const { url } = useFileImage(file, access, visible && previewImage(file), true)
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
