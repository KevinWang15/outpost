import { useEffect, useRef } from 'react'
import { CircleAlert, CircleCheck, X } from 'lucide-react'

export default function Toast({
  message,
  tone,
  onClose,
}: {
  message: string
  tone: 'success' | 'warning'
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Promote after the containing dialog opens, keeping the toast above it.
    const frame = requestAnimationFrame(() => ref.current?.showPopover())
    const timer = setTimeout(onClose, 8_000)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [onClose])
  return (
    <div ref={ref} popover="manual" className={`toast ${tone}`} role="status" aria-atomic="true">
      {tone === 'warning' ? <CircleAlert size={19} aria-hidden="true" /> : <CircleCheck size={19} aria-hidden="true" />}
      <p>{message}</p>
      <button className="icon-button" aria-label="Dismiss notification" onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  )
}
