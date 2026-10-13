import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'

/** Modal dialog. Only explicit Close/Cancel controls dismiss it, so drafts are never lost to a stray click or Escape. */
export function Dialog({
  title,
  description,
  onClose,
  children,
  footer,
  size = 'medium',
  busy = false,
  className = '',
}: {
  title: ReactNode
  description?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  size?: 'small' | 'medium' | 'large'
  busy?: boolean
  className?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  return (
    <dialog
      ref={ref}
      className={`dialog dialog-${size} ${className}`}
      closedby="none"
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-description` : undefined}
      onCancel={event => {
        if (event.target === event.currentTarget) event.preventDefault()
      }}
    >
      <header className="dialog-header">
        <div>
          <h2 id={`${id}-title`}>{title}</h2>
          {description && <p id={`${id}-description`}>{description}</p>}
        </div>
        <button className="icon-button" aria-label="Close dialog" disabled={busy} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="dialog-body">{children}</div>
      {footer && <footer className="dialog-footer">{footer}</footer>}
    </dialog>
  )
}

export function Confirm({
  title,
  description,
  action,
  onConfirm,
  onClose,
}: {
  title: string
  description: string
  action: string
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const [working, setWorking] = useState(false),
    [error, setError] = useState('')
  async function confirm() {
    setWorking(true)
    setError('')
    try {
      await onConfirm()
      onClose()
    } catch (problem) {
      setError((problem as Error).message)
      setWorking(false)
    }
  }
  return (
    <Dialog
      title={title}
      description={description}
      size="small"
      busy={working}
      onClose={onClose}
      footer={
        <>
          <button className="button" disabled={working} onClick={onClose}>
            Cancel
          </button>
          <button className="button danger" disabled={working} onClick={() => void confirm()}>
            {working ? 'Working…' : action}
          </button>
        </>
      }
    >
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  )
}
