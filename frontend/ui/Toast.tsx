import { useCallback, useRef, useState, type ReactNode } from 'react'
import { CircleAlert, CircleCheck, X } from 'lucide-react'
import { ToastContext, type Tone } from './toast-context'

interface Toast { id: number; message: string; tone: Tone }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const next = useRef(0)
  const dismiss = useCallback((id: number) => setToasts(current => current.filter(toast => toast.id !== id)), [])
  const show = useCallback((message: string, tone: Tone = 'success') => {
    const id = ++next.current
    setToasts(current => [...current.slice(-2), { id, message, tone }])
    setTimeout(() => dismiss(id), tone === 'error' ? 8000 : 4000)
  }, [dismiss])
  return <ToastContext.Provider value={show}>
    {children}
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map(toast => <div key={toast.id} className={`toast ${toast.tone}`}>
        {toast.tone === 'error' ? <CircleAlert size={16} /> : <CircleCheck size={16} />}
        <span>{toast.message}</span>
        <button className="icon-button" aria-label="Dismiss" onClick={() => dismiss(toast.id)}><X size={14} /></button>
      </div>)}
    </div>
  </ToastContext.Provider>
}
