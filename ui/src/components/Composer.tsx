import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { matchCommands, parseSlash, type Cmd } from '../commands'
import { useT } from '../i18n'
import { Button, Icon } from './ui'

interface MenuItem {
  key: string
  label: string
  detail?: string
  /** What the box holds after choosing it. */
  apply: (text: string) => string
  /** Run straight away instead of filling the box. */
  run?: () => void
}

function readDraft(key?: string): string {
  if (!key) return ''
  try {
    return sessionStorage.getItem(`vara.draft.${key}`) ?? ''
  } catch {
    return ''
  }
}
function writeDraft(key: string | undefined, value: string): void {
  if (!key) return
  try {
    if (value) sessionStorage.setItem(`vara.draft.${key}`, value)
    else sessionStorage.removeItem(`vara.draft.${key}`)
  } catch {
    /* a draft is a convenience */
  }
}

/**
 * The message box. Enter sends, Shift+Enter adds a line (never while an IME is composing, which
 * matters for Arabic and CJK). `/` opens the commands you may use; `@` completes project files
 * (owner). A half-written message survives switching sessions.
 */
export function Composer({
  onSend,
  disabled,
  busy,
  placeholder,
  onPause,
  canPause,
  controls,
  autoFocus,
  big,
  commands,
  files,
  draftKey,
  onUnknownCommand,
}: {
  onSend: (text: string) => Promise<void> | void
  disabled?: boolean
  busy?: boolean
  placeholder?: string
  onPause?: () => void
  canPause?: boolean
  controls?: React.ReactNode
  autoFocus?: boolean
  big?: boolean
  commands?: Cmd[]
  /** Offer @file completion (the owner's project files). */
  files?: boolean
  draftKey?: string
  onUnknownCommand?: (name: string) => void
}) {
  const t = useT()
  const [text, setTextState] = useState(() => readDraft(draftKey))
  const [sending, setSending] = useState(false)
  const [caret, setCaret] = useState(0)
  const [sel, setSel] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [found, setFound] = useState<string[]>([])
  const ref = useRef<HTMLTextAreaElement>(null)

  const setText = (v: string): void => {
    setTextState(v)
    writeDraft(draftKey, v)
    setDismissed(false)
  }

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, big ? 280 : 200)}px`
  }, [text, big])

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  // The word being typed after an @ (only before the caret, only at a word start).
  const mention = files ? /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret)) : null
  const mentionQuery = mention ? mention[2]! : null
  useEffect(() => {
    if (mentionQuery === null) return setFound([])
    let live = true
    const id = setTimeout(() => {
      api<string[]>('GET', `/api/files?q=${encodeURIComponent(mentionQuery)}`)
        .then((r) => live && setFound(r))
        .catch(() => live && setFound([]))
    }, 120)
    return () => {
      live = false
      clearTimeout(id)
    }
  }, [mentionQuery])

  const slash = commands && /^\/[\w-]*$/.test(text) ? text.slice(1) : null
  const argMode = commands ? /^\/([\w-]+)\s+(\S*)$/.exec(text) : null

  const menu: MenuItem[] = useMemo(() => {
    if (disabled) return []
    if (mentionQuery !== null && found.length) {
      return found.map((f) => ({ key: f, label: f, apply: (cur: string) => `${cur.slice(0, caret).replace(/@[^\s@]*$/, `@${f} `)}${cur.slice(caret)}` }))
    }
    if (argMode && commands) {
      const c = commands.find((x) => x.slash === argMode[1]!.toLowerCase())
      if (c?.options) return c.options.filter((o) => o.startsWith(argMode[2]!.toLowerCase())).map((o) => ({ key: o, label: o, detail: c.title, apply: () => `/${c.slash} ${o}` }))
    }
    if (slash !== null && commands) {
      const list = slash ? commands.filter((c) => c.slash && c.slash.startsWith(slash.toLowerCase())) : commands.filter((c) => c.slash)
      const ranked = list.length ? list : matchCommands(commands, slash).filter((c) => c.slash)
      return ranked.slice(0, 8).map((c) => ({
        key: c.id,
        label: `/${c.slash}${c.args ? ` ${c.args}` : ''}`,
        detail: c.description ?? c.title,
        apply: () => `/${c.slash} `,
      }))
    }
    return []
  }, [disabled, mentionQuery, found, argMode, commands, slash, caret])

  const open = menu.length > 0 && !dismissed
  useEffect(() => setSel(0), [menu.length, mentionQuery, slash])

  const choose = (item: MenuItem): void => {
    const next = item.apply(text)
    setText(next)
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(next.length, next.length)
      setCaret(next.length)
    })
  }

  const submit = async (): Promise<void> => {
    const value = text.trim()
    if (!value || disabled || sending) return
    const cmd = commands ? parseSlash(value) : null
    if (cmd && commands) {
      const c = commands.find((x) => x.slash === cmd.name)
      if (!c) {
        onUnknownCommand?.(cmd.name)
        return
      }
      setText('')
      await c.run(cmd.arg)
      return
    }
    setSending(true)
    try {
      await onSend(value)
      setText('')
    } finally {
      setSending(false)
      ref.current?.focus()
    }
  }

  return (
    <div className={`composer${disabled ? ' is-disabled' : ''}${big ? ' composer-big' : ''}`}>
      {open ? (
        <ul className="menu" role="listbox" aria-label={mentionQuery !== null ? t('c_files') : t('c_commands')}>
          {menu.map((m, i) => (
            <li key={m.key} role="presentation">
              <button role="option" aria-selected={i === sel} className={`menu-item${i === sel ? ' on' : ''}`} onMouseDown={(e) => (e.preventDefault(), choose(m))} onMouseMove={() => setSel(i)}>
                <span className="mono" dir="ltr">
                  {m.label}
                </span>
                {m.detail ? <span className="muted menu-detail">{m.detail}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        ref={ref}
        value={text}
        rows={big ? 3 : 1}
        dir="auto"
        disabled={disabled}
        placeholder={placeholder ?? t('placeholder')}
        aria-label={placeholder ?? t('placeholder')}
        aria-expanded={open}
        onChange={(e) => (setText(e.target.value), setCaret(e.target.selectionStart))}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (open) {
            if (e.key === 'ArrowDown') return (e.preventDefault(), setSel((s) => (s + 1) % menu.length))
            if (e.key === 'ArrowUp') return (e.preventDefault(), setSel((s) => (s - 1 + menu.length) % menu.length))
            if (e.key === 'Escape') return (e.preventDefault(), setDismissed(true))
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
              const item = menu[sel]!
              e.preventDefault()
              // Enter on a command that is already complete runs it instead of re-filling the box.
              if (e.key === 'Enter' && mentionQuery === null && item.apply(text).trim() === text.trim()) return void submit()
              return choose(item)
            }
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void submit()
          }
        }}
      />
      <div className="composer-bar">
        <div className="composer-controls">{controls}</div>
        <div className="composer-actions">
          {busy && canPause && onPause ? (
            <Button kind="ghost" icon="pause" onClick={onPause} title={t('pause')}>
              {t('pause')}
            </Button>
          ) : null}
          <button className="send" onClick={() => void submit()} disabled={disabled || sending || !text.trim()} aria-label={t('send')} title={t('send')}>
            <Icon name="send" size={18} />
          </button>
        </div>
      </div>
    </div>
  )
}
