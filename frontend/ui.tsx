import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  className,
  closeDisabled = false,
}: {
  title: string
  subtitle: string
  onClose: () => void
  children: ReactNode
  className?: string
  closeDisabled?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  function close() { if (!closeDisabled) onClose() }
  return (
    <dialog
      ref={ref}
      className={className}
      closedby="none"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return
        event.preventDefault()
      }}
    >
      <div className="modal-heading">
        <span className="eyebrow">OUTPOST / AI SESSION MANAGER</span>
        <button className="icon-button" aria-label="Close dialog" disabled={closeDisabled} onClick={close}>
          <X />
        </button>
      </div>
      <h2 id={`${id}-title`}>{title}</h2>
      <p className="modal-subtitle" id={`${id}-description`}>{subtitle}</p>
      {children}
    </dialog>
  )
}
