import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { RegistryContext, matchCommands, parseSlash, type Cmd } from '../commands'
import { useT } from '../i18n'
import { relativeTime } from '../transcript'
import type { SessionSummary } from '../types'
import { Icon } from './ui'

interface Item {
  key: string
  title: string
  description?: string
  group: string
  shortcut?: string
  right?: string
  run: () => void
  /** Selecting it fills the box instead of running (a command that needs an argument). */
  fill?: string
}

const GROUP_ORDER = ['session', 'go', 'skill', 'settings', 'theme', 'open']

/** Ctrl K: every command and every session in one search box. `/command arg` works here too. */
export function Palette({ onClose, sessions, onOpen }: { onClose: () => void; sessions: SessionSummary[]; onOpen: (id: string) => void }) {
  const t = useT()
  const reg = useContext(RegistryContext)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const cmds = useMemo(() => reg.all(), [reg])

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    input.current?.focus()
    return () => prev?.focus?.()
  }, [])

  const slash = q.startsWith('/') ? parseSlash(q.length > 1 ? q : '/') : null
  const items: Item[] = useMemo(() => {
    const toItem = (c: Cmd): Item => ({
      key: c.id,
      title: c.title,
      group: c.group,
      ...(c.description ? { description: c.description } : {}),
      ...(c.shortcut ? { shortcut: c.shortcut } : {}),
      ...(c.slash ? { right: `/${c.slash}${c.args ? ` ${c.args}` : ''}` } : {}),
      run: () => void c.run(''),
      ...(c.args ? { fill: `/${c.slash ?? c.id} ` } : {}),
    })
    if (q.startsWith('/')) {
      const name = (slash?.name ?? '').toLowerCase()
      const exact = cmds.find((c) => c.slash === name)
      if (exact && (slash?.arg || q.endsWith(' '))) {
        // An argument is being typed: offer the command's values, or just run what was typed.
        const opts = (exact.options ?? []).filter((o) => o.toLowerCase().startsWith((slash?.arg ?? '').toLowerCase()))
        const rows: Item[] = opts.map((o) => ({ key: `${exact.id}:${o}`, title: `/${exact.slash} ${o}`, description: exact.title, group: exact.group, run: () => void exact.run(o) }))
        if (slash?.arg && !opts.includes(slash.arg)) rows.unshift({ key: `${exact.id}:typed`, title: `/${exact.slash} ${slash.arg}`, description: exact.title, group: exact.group, run: () => void exact.run(slash.arg) })
        return rows.length ? rows : [{ key: exact.id, title: exact.title, group: exact.group, run: () => void exact.run('') }]
      }
      return cmds.filter((c) => c.slash && c.slash.startsWith(name)).map(toItem)
    }
    const found = matchCommands(cmds, q).map(toItem)
    const sess: Item[] = sessions
      .filter((s) => !q.trim() || s.objective.toLowerCase().includes(q.trim().toLowerCase()))
      .slice(0, q.trim() ? 12 : 5)
      .map((s) => ({ key: `s:${s.id}`, title: s.objective, group: 'open', right: relativeTime(s.updatedAt), run: () => onOpen(s.id) }))
    return [...found, ...sess]
  }, [q, cmds, sessions, onOpen, slash?.name, slash?.arg])

  const ordered = useMemo(() => [...items].sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group)), [items])
  useEffect(() => setSel(0), [q])
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [sel, ordered.length])

  const choose = (item: Item | undefined): void => {
    if (!item) return
    if (item.fill) return setQ(item.fill)
    onClose()
    item.run()
  }
  const groupLabel = (g: string): string => t(`pal_${g}` as 'pal_go')
  let lastGroup = ''
  return (
    <div className="overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={t('pal_title')}>
        <div className="palette-input">
          <Icon name="search" size={18} />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('pal_placeholder')}
            aria-label={t('pal_placeholder')}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            dir="auto"
            onKeyDown={(e) => {
              if (e.key === 'Escape') return onClose()
              if (e.key === 'ArrowDown') (e.preventDefault(), setSel((s) => Math.min(ordered.length - 1, s + 1)))
              else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((s) => Math.max(0, s - 1)))
              else if (e.key === 'Enter' && !e.nativeEvent.isComposing) (e.preventDefault(), choose(ordered[sel]))
              else if (e.key === 'Tab' && ordered[sel]?.fill) (e.preventDefault(), setQ(ordered[sel]!.fill!))
            }}
          />
        </div>
        <ul id="palette-list" className="palette-list" role="listbox" ref={list}>
          {ordered.length === 0 ? <li className="palette-empty muted">{t('pal_none')}</li> : null}
          {ordered.map((it, i) => {
            const head = it.group !== lastGroup ? groupLabel(it.group) : null
            lastGroup = it.group
            return (
              <li key={it.key} role="presentation">
                {head ? <div className="palette-group">{head}</div> : null}
                <button role="option" aria-selected={i === sel} className={`palette-item${i === sel ? ' on' : ''}`} onMouseMove={() => setSel(i)} onClick={() => choose(it)}>
                  <span className="palette-title" dir="auto">
                    {it.title}
                  </span>
                  {it.description ? <span className="muted palette-desc">{it.description}</span> : null}
                  {it.shortcut ? (
                    <span className="palette-right">
                      {it.shortcut.split(' ').map((k) => (
                        <kbd key={k}>{k}</kbd>
                      ))}
                    </span>
                  ) : it.right ? (
                    <span className="palette-right muted mono" dir="ltr">
                      {it.right}
                    </span>
                  ) : null}
                </button>
              </li>
            )
          })}
        </ul>
        <div className="palette-foot muted">
          <span><kbd>↑</kbd><kbd>↓</kbd> {t('pal_move')}</span>
          <span><kbd>Enter</kbd> {t('pal_run')}</span>
          <span><kbd>Esc</kbd> {t('close')}</span>
        </div>
      </div>
    </div>
  )
}
