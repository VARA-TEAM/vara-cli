import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useT, type Key } from '../i18n'

/** Tiny inline icon set (stroke icons, 24x24). */
const PATHS: Record<string, string> = {
  send: 'M4 12l16-8-6 16-2.5-6.5L4 12z',
  plus: 'M12 5v14M5 12h14',
  share: 'M16 6l-4-4-4 4M12 2v13M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7',
  users: 'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM22 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  copy: 'M9 9h10a2 2 0 012 2v10a2 2 0 01-2 2H9a2 2 0 01-2-2V11a2 2 0 012-2zM5 15H4a2 2 0 01-2-2V3a2 2 0 012-2h10a2 2 0 012 2v1',
  check: 'M20 6L9 17l-5-5',
  x: 'M18 6L6 18M6 6l12 12',
  chevron: 'M9 6l6 6-6 6',
  file: 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6',
  terminal: 'M4 17l6-6-6-6M12 19h8',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  menu: 'M3 6h18M3 12h18M3 18h18',
  panel: 'M3 4h18v16H3zM15 4v16',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
  logout: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9',
  search: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3',
  branch: 'M6 3v12M18 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM18 9a9 9 0 01-9 9',
  spark: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3zM19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8L19 17z',
  trash: 'M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6',
  link: 'M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7',
  down: 'M12 5v14M19 12l-7 7-7-7',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
}

export function Icon({ name, size = 18, className }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? ''} />
    </svg>
  )
}

export function Button({
  children,
  onClick,
  kind = 'default',
  disabled,
  icon,
  title,
  type = 'button',
  small,
}: {
  children?: ReactNode
  onClick?: () => void
  kind?: 'default' | 'primary' | 'ghost' | 'danger'
  disabled?: boolean
  icon?: string
  title?: string
  type?: 'button' | 'submit'
  small?: boolean
}) {
  return (
    <button type={type} className={`btn btn-${kind}${small ? ' btn-sm' : ''}`} onClick={onClick} disabled={disabled} title={title} aria-label={title}>
      {icon ? <Icon name={icon} size={small ? 15 : 17} /> : null}
      {children}
    </button>
  )
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <label className={`switch${disabled ? ' is-disabled' : ''}`}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      <span className="switch-label">{label}</span>
    </label>
  )
}

const STATE_TONE: Record<string, string> = {
  running: 'ok',
  completed: 'ok',
  ready: 'accent',
  waiting_user: 'warn',
  paused: 'warn',
  interrupted: 'err',
  failed: 'err',
  stopped: 'muted',
  idle: 'muted',
}

export function StateBadge({ state }: { state: string }) {
  const t = useT()
  const label = (`state_${state}` as Key)
  return (
    <span className={`badge tone-${STATE_TONE[state] ?? 'muted'}`}>
      {state === 'running' ? <span className="pulse" aria-hidden="true" /> : null}
      {t(label)}
    </span>
  )
}

export function Badge({ children, tone = 'muted', title }: { children: ReactNode; tone?: 'muted' | 'ok' | 'warn' | 'err' | 'accent' | 'brand' | 'user'; title?: string }) {
  return (
    <span className={`badge tone-${tone}`} title={title}>
      {children}
    </span>
  )
}

export function Dialog({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    ref.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
  }, [onClose])
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog${wide ? ' dialog-wide' : ''}`} role="dialog" aria-modal="true" tabIndex={-1} ref={ref}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('close')}>
            <Icon name="x" />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  )
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const t = useT()
  const [done, setDone] = useState(false)
  return (
    <Button
      small
      kind="ghost"
      icon={done ? 'check' : 'copy'}
      title={label ?? t('copy')}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setDone(true)
            setTimeout(() => setDone(false), 1500)
          })
          .catch(() => {})
      }}
    >
      {done ? t('copied') : (label ?? t('copy'))}
    </Button>
  )
}

export function Field({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  )
}
