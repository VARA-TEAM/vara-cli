import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { ApiError } from '../api'
import { Icon } from './ui'

type Tone = 'ok' | 'err' | 'info'
interface ToastItem {
  id: number
  text: string
  tone: Tone
}

const ToastCtx = createContext<(text: string, tone?: Tone) => void>(() => {})

/** Short confirmations and errors that answer an action. They leave by themselves (errors stay longer). */
export function ToastHost({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const next = useRef(1)
  const push = useCallback((text: string, tone: Tone = 'ok') => {
    const id = next.current++
    setItems((l) => [...l.slice(-3), { id, text, tone }])
    setTimeout(() => setItems((l) => l.filter((t) => t.id !== id)), tone === 'err' ? 7000 : 2800)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <Icon name={t.tone === 'err' ? 'alert' : 'check'} size={16} />
            <span dir="auto">{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

export const useToast = (): ((text: string, tone?: Tone) => void) => useContext(ToastCtx)

/** Save a text file from the browser (used by export). */
export function downloadText(filename: string, text: string, type = 'text/markdown'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/**
 * Run an action with a "busy" label (so buttons can disable themselves) and a toast for the
 * outcome. Returns the result, or undefined when it failed (the error is already shown).
 */
export function useAct(): { busy: string | null; act: <T>(label: string, fn: () => Promise<T>, okText?: string) => Promise<T | undefined> } {
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const act = useCallback(
    async <T,>(label: string, fn: () => Promise<T>, okText?: string): Promise<T | undefined> => {
      setBusy(label)
      try {
        const r = await fn()
        if (okText) toast(okText, 'ok')
        return r
      } catch (e) {
        toast(e instanceof ApiError || e instanceof Error ? e.message : String(e), 'err')
        return undefined
      } finally {
        setBusy(null)
      }
    },
    [toast],
  )
  return { busy, act }
}
