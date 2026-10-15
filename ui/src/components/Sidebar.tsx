import { useEffect, useRef, useState } from 'react'
import { useT } from '../i18n'
import { relativeTime } from '../transcript'
import type { Me, SessionSummary } from '../types'
import { Icon, StateBadge } from './ui'

import type { SettingsTab } from './Settings'

export type Route = { page: 'home' } | { page: 'session'; id: string } | { page: 'team' } | { page: 'settings'; tab?: SettingsTab }

function Item({ s, active, open, showDir, onOpen, onSplit }: { s: SessionSummary; active: boolean; open: boolean; showDir: boolean; onOpen: (id: string) => void; onSplit?: (id: string) => void }) {
  const t = useT()
  const dir = s.cwd.split(/[\\/]/).filter(Boolean).pop() ?? ''
  return (
    <li className="si-row">
      <button className={`session-item${active ? " active" : ""}${open ? " is-open" : ""}`} onClick={() => onOpen(s.id)} aria-current={active ? "page" : undefined}>
        <span className="si-title" dir="auto">
          {s.objective}
        </span>
        <span className="si-meta">
          <StateBadge state={s.state} />
          {s.participant ? <span className="si-who">{s.participant.name}</span> : null}
          {showDir && dir ? <span className="si-dir" dir="ltr" title={s.cwd}>{dir}</span> : null}
          <span className="si-time">{relativeTime(s.updatedAt)}</span>
        </span>
      </button>
      {onSplit && !active ? (
        <button className="si-split icon-btn" onClick={() => onSplit(s.id)} aria-label={t("wb_splitWith") + ": " + s.objective} title={t("wb_splitWith")}>
          <Icon name="columns" size={14} />
        </button>
      ) : null}
    </li>
  )
}

/** Sessions whose id or objective contains every word typed (the terminal's /sessions filter). */
export function filterSessions(list: SessionSummary[], query: string): SessionSummary[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return list
  return list.filter((s) => {
    const hay = `${s.id} ${s.objective} ${s.participant?.name ?? ''} ${s.cwd}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

export function Sidebar({
  me,
  host,
  sessions,
  route,
  onRoute,
  onSignOut,
  open,
  onClose,
  onPalette,
  folder,
  onFolder,
  scopeAll,
  onScope,
  openIds,
  onSplit,
}: {
  me: Me
  host: { folder: string; version: string } | null
  sessions: SessionSummary[]
  route: Route
  onRoute: (r: Route) => void
  onSignOut: () => void
  open: boolean
  onClose: () => void
  onPalette: () => void
  /** Full path of the working folder (owner can change it). */
  folder?: string
  onFolder?: () => void
  /** Show the sessions of every folder, not only this one (the terminal's `/sessions --all`). */
  scopeAll: boolean
  onScope: (all: boolean) => void
  /** Sessions open in a tab. */
  openIds: string[]
  onSplit?: (id: string) => void
}) {
  const t = useT()
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null)
  const activeId = route.page === 'session' ? route.id : null
  const owner = me.role === 'owner'
  const shown = filterSessions(sessions, query)
  // The owner sees everyone's work: their own first, then each guest's.
  const mine = shown.filter((s) => !s.participant)
  const others = shown.filter((s) => s.participant)
  const go = (r: Route): void => {
    onRoute(r)
    onClose()
  }
  // `/sessions` focuses the filter.
  useEffect(() => {
    const on = (): void => search.current?.focus()
    window.addEventListener('vara:sessions', on)
    return () => window.removeEventListener('vara:sessions', on)
  }, [])
  const item = (s: SessionSummary): JSX.Element => (
    <Item key={s.id} s={s} active={s.id === activeId} open={openIds.includes(s.id)} showDir={scopeAll} onOpen={(id) => go({ page: 'session', id })} {...(onSplit ? { onSplit } : {})} />
  )
  return (
    <>
      {open ? <div className="scrim show" onClick={onClose} /> : null}
      <nav className={`sidebar${open ? ' open' : ''}`} aria-label={t('sessions')}>
        <div className="brand">
          <svg viewBox="0 0 64 64" width="26" height="26" aria-hidden="true">
            <path d="M12 18l13 30 13-30" fill="none" stroke="var(--brand)" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M40 48l6-14 6 14M42.4 43h7.2" fill="none" stroke="var(--accent)" strokeWidth="4.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div className="brand-text">
            <strong>VARA</strong>
            {onFolder ? (
              <button className="folder-btn muted brand-sub" dir="ltr" onClick={onFolder} title={`${folder ?? ''} — ${t('f_change')}`}>
                {(folder ?? host?.folder ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''} <Icon name="chevron" size={11} className="chev open" />
              </button>
            ) : host ? (
              <span className="muted brand-sub" dir="ltr">{host.folder}</span>
            ) : null}
          </div>
        </div>

        <button className="new-btn" onClick={() => go({ page: 'home' })}>
          <Icon name="plus" size={16} /> {t('newSession')}
        </button>

        <button className="search-btn" onClick={() => (onClose(), onPalette())} aria-label={t('pal_title')}>
          <Icon name="command" size={15} />
          <span>{t('pal_short')}</span>
          <span className="kbds"><kbd>Ctrl</kbd><kbd>K</kbd></span>
        </button>

        <div className="session-filter">
          <Icon name="search" size={14} />
          <input
            ref={search}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('')
              if (e.key === 'Enter' && shown[0]) go({ page: 'session', id: shown[0].id })
            }}
            placeholder={t('sb_filter')}
            aria-label={t('sb_filter')}
          />
          <div className="seg seg-sm" role="group" aria-label={t('sb_scope')}>
            <button className={!scopeAll ? 'on' : ''} aria-pressed={!scopeAll} onClick={() => onScope(false)} title={t('sb_thisFolder')}>
              <Icon name="folder" size={13} />
            </button>
            <button className={scopeAll ? 'on' : ''} aria-pressed={scopeAll} onClick={() => onScope(true)} title={t('sb_allFolders')}>
              <Icon name="list" size={13} />
            </button>
          </div>
        </div>

        <div className="sidebar-scroll">
          {sessions.length === 0 ? (
            <div className="sb-empty">
              <p className="muted">{t('noSessions')}</p>
              {!scopeAll ? (
                <button className="linklike" onClick={() => onScope(true)}>
                  {t('sb_showAll')}
                </button>
              ) : null}
            </div>
          ) : shown.length === 0 ? (
            <p className="muted pad">{t('sb_noMatch', { q: query })}</p>
          ) : null}
          {mine.length ? (
            <>
              <h3>{owner ? t('yourSessions') : t('sharedWithYou')}</h3>
              <ul>{mine.map(item)}</ul>
            </>
          ) : null}
          {others.length ? (
            <>
              <h3>{owner ? t('guests') : t('yourSessions')}</h3>
              <ul>{others.map(item)}</ul>
            </>
          ) : null}
        </div>

        <div className="sidebar-foot">
          {owner ? (
            <button className={`nav-btn${route.page === 'team' ? ' active' : ''}`} onClick={() => go({ page: 'team' })}>
              <Icon name="users" size={17} /> {t('admin')}
            </button>
          ) : null}
          <button className={`nav-btn${route.page === 'settings' ? ' active' : ''}`} onClick={() => go({ page: 'settings' })}>
            <Icon name="settings" size={17} /> {t('settings')}
          </button>
          <button className="nav-btn" onClick={() => (onClose(), window.dispatchEvent(new Event('vara:help')))}>
            <Icon name="keyboard" size={17} /> {t('cmd_help')}
          </button>
          <div className="who">
            <span className="who-name" dir="auto">
              {owner ? t('appName') + ' · owner' : me.name}
            </span>
            {me.role === 'guest' ? (
              <button className="icon-btn" onClick={onSignOut} aria-label={t('signOut')} title={t('signOut')}>
                <Icon name="logout" size={16} />
              </button>
            ) : null}
          </div>
        </div>
      </nav>
    </>
  )
}
