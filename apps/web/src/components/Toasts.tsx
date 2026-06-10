/** Minimal toast stack for transient errors/notices. */
import { useCallback, useRef, useState } from 'react'

export interface Toast {
  id: number
  text: string
}

const TOAST_MS = 5000

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(0)

  const pushToast = useCallback((text: string) => {
    const id = nextId.current++
    setToasts((prev) => [...prev, { id, text }])
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), TOAST_MS)
  }, [])

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  return { toasts, pushToast, dismissToast }
}

export function ToastShelf({
  toasts,
  onDismiss,
}: {
  toasts: Toast[]
  onDismiss: (id: number) => void
}) {
  if (toasts.length === 0) return null
  return (
    <div className="toast-shelf" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <button key={toast.id} className="toast" onClick={() => onDismiss(toast.id)}>
          {toast.text}
        </button>
      ))}
    </div>
  )
}
