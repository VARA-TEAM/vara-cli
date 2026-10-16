import { useEffect, useMemo, useRef, useState } from 'react'
import { api, uploadFile, type UploadInfo } from '../api'
import { useToast } from './toast'
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
  mentions,
  draftKey,
  onUnknownCommand,
  attachable = true,
}: {
  onSend: (text: string, attachments: string[]) => Promise<void> | void
  /** Allow attaching files (drag, paste, the clip button). On by default. */
  attachable?: boolean
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
  /** What `@` can point at besides files: skills, MCP servers, parallel agents, the web. */
  mentions?: Array<{ name: string; detail: string }>
  draftKey?: string
  onUnknownCommand?: (name: string) => void
}) {
  const t = useT()
  const toast = useToast()
  const [picks, setPicks] = useState<Array<UploadInfo | { id: string; name: string; pending: true }>>([])
  const [over, setOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const [text, setTextState] = useState(() => readDraft(draftKey))
  const [sending, setSending] = useState(false)
  const [caret, setCaret] = useState(0)
  const [sel, setSel] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [found, setFound] = useState<string[]>([])
  const ref = useRef<HTMLTextAreaElement>(null)
  const escArmed = useRef(false)
  const [armed, setArmed] = useState(false)

  // `/attach` (from the command list) opens the file picker of the composer it was meant for.
  useEffect(() => {
    if (!draftKey) return
    const on = (e: Event): void => {
      if ((e as CustomEvent<{ id?: string }>).detail?.id === draftKey) fileInput.current?.click()
    }
    window.addEventListener('vara:attach', on)
    return () => window.removeEventListener('vara:attach', on)
  }, [draftKey])

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
  const mention = files || mentions?.length ? /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret)) : null
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
    if (mentionQuery !== null && (found.length || mentions?.length)) {
      const q = mentionQuery.toLowerCase()
      const caps = (mentions ?? []).filter((m) => m.name.toLowerCase().startsWith(q)).slice(0, 8)
      const capItems: MenuItem[] = caps.map((m) => ({ key: `cap:${m.name}`, label: `@${m.name}`, detail: m.detail, apply: (cur: string) => `${cur.slice(0, caret).replace(/@[^\s@]*$/, `@${m.name} `)}${cur.slice(caret)}` }))
      const fileItems: MenuItem[] = found.map((f) => ({ key: f, label: f, apply: (cur: string) => `${cur.slice(0, caret).replace(/@[^\s@]*$/, `@${f} `)}${cur.slice(caret)}` }))
      return [...capItems, ...fileItems]
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
  }, [disabled, mentionQuery, found, mentions, argMode, commands, slash, caret])

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

  const canAttach = attachable && !disabled
  const addFiles = (list: FileList | File[]): void => {
    for (const file of Array.from(list).slice(0, 6)) {
      const tmp = `pending-${Math.random().toString(36).slice(2)}`
      setPicks((p) => [...p, { id: tmp, name: file.name || 'pasted-image', pending: true }])
      uploadFile(file)
        .then((info) => setPicks((p) => p.map((x) => (x.id === tmp ? info : x))))
        .catch((e: Error) => {
          setPicks((p) => p.filter((x) => x.id !== tmp))
          toast(t('attach_failed', { name: file.name || 'file', why: e.message }), 'err')
        })
    }
  }
  const ready = picks.filter((p): p is UploadInfo => !('pending' in p))
  const uploading = picks.length > ready.length

  const submit = async (): Promise<void> => {
    const value = text.trim() || (ready.length ? '(see the attached files)' : '')
    if (!value || disabled || sending || uploading) return
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
      await onSend(value, ready.map((r) => r.id))
      setText('')
      setPicks([])
    } finally {
      setSending(false)
      ref.current?.focus()
    }
  }

  return (
    <div
      className={`composer${disabled ? ' is-disabled' : ''}${big ? ' composer-big' : ''}${over ? ' drop' : ''}`}
      onDragOver={(e) => {
        if (!canAttach || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        if (!canAttach || !e.dataTransfer.files.length) return
        e.preventDefault()
        addFiles(e.dataTransfer.files)
      }}
    >
      {picks.length ? (
        <div className="picks">
          {picks.map((p) => (
            <span className={`pick${'pending' in p ? ' busy' : ''}`} key={p.id} title={p.name}>
              <Icon name={'kind' in p && p.kind === 'image' ? 'eye' : 'file'} size={13} />
              <span>{p.name}</span>
              <button type="button" aria-label={t('attach_remove', { name: p.name })} onClick={() => setPicks((all) => all.filter((x) => x.id !== p.id))}>
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
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
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files)
          if (!canAttach || !files.length) return
          e.preventDefault()
          addFiles(files)
        }}
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
          // Esc twice pauses a running agent (the terminal's interrupt): the first press only arms it.
          if (e.key === 'Escape' && busy && canPause && onPause) {
            e.preventDefault()
            if (escArmed.current) (escArmed.current = false, setArmed(false), onPause())
            else {
              escArmed.current = true
              setArmed(true)
              setTimeout(() => ((escArmed.current = false), setArmed(false)), 2500)
            }
            return
          }
          // Ctrl+J adds a line, as in the terminal.
          if (e.key.toLowerCase() === 'j' && e.ctrlKey && !e.altKey && !e.metaKey) {
            e.preventDefault()
            const el = e.currentTarget
            const next = `${text.slice(0, el.selectionStart)}\n${text.slice(el.selectionEnd)}`
            const pos = el.selectionStart + 1
            setText(next)
            requestAnimationFrame(() => (el.setSelectionRange(pos, pos), setCaret(pos)))
            return
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void submit()
          }
        }}
      />
      <div className="composer-bar">
        <div className="composer-controls">
          {canAttach ? (
            <>
              <input ref={fileInput} type="file" multiple hidden onChange={(e) => (e.target.files && addFiles(e.target.files), (e.target.value = ''))} />
              <button type="button" className="attach-btn" onClick={() => fileInput.current?.click()} aria-label={t('attach')} title={t('attach')}>
                <Icon name="clip" size={17} />
              </button>
            </>
          ) : null}
          {controls}
        </div>
        <div className="composer-actions">
          {armed ? <span className="muted small" role="status">{t('c_escAgain')}</span> : null}
          {busy && canPause && onPause ? (
            <Button kind="ghost" icon="pause" onClick={onPause} title={t('pause')}>
              {t('pause')}
            </Button>
          ) : null}
          <button className="send" onClick={() => void submit()} disabled={disabled || sending || uploading || (!text.trim() && !ready.length)} aria-label={t('send')} title={t('send')}>
            <Icon name="send" size={18} />
          </button>
        </div>
      </div>
    </div>
  )
}
