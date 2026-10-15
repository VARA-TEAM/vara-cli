import { useT } from '../i18n'
import { relativeTime } from '../transcript'
import type { Me, SessionSummary } from '../types'
import { Icon, StateBadge } from './ui'

import type { SettingsTab } from './Settings'

export type Route = { page: 'home' } | { page: 'session'; id: string } | { page: 'team' } | { page: 'settings'; tab?: SettingsTab }

function Item({ s, active, onOpen }: { s: SessionSummary; active: boolean; onOpen: (id: string) => void }) {
  return (
    <li>
      <button className={`session-item${active ? ' active' : ''}`} onClick={() => onOpen(s.id)} aria-current={active ? 'page' : undefined}>
        <span className="si-title" dir="auto">
          {s.objective}
        </span>
        <span className="si-meta">
          <StateBadge state={s.state} />
          {s.participant ? <span className="si-who">{s.participant.name}</span> : null}
          <span className="si-time">{relativeTime(s.updatedAt)}</span>
        </span>
      </button>
    </li>
  )
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
}) {
  const t = useT()
  const activeId = route.page === 'session' ? route.id : null
  const owner = me.role === 'owner'
  // The owner sees everyone's work: their own first, then each guest's.
  const mine = sessions.filter((s) => !s.participant)
  const others = sessions.filter((s) => s.participant)
  const go = (r: Route): void => {
    onRoute(r)
    onClose()
  }
  return (
    <>
      {open ? <div className="scrim" onClick={onClose} /> : null}
      <nav className={`sidebar${open ? ' open' : ''}`} aria-label={t('sessions')}>
        <div className="brand">
          <svg viewBox="0 0 64 64" width="26" height="26" aria-hidden="true">
            <path d="M12 18l13 30 13-30" fill="none" stroke="var(--brand)" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M40 48l6-14 6 14M42.4 43h7.2" fill="none" stroke="var(--accent)" strokeWidth="4.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div>
            <strong>VARA</strong>
            {onFolder ? (
              <button className="folder-btn muted brand-sub" dir="ltr" onClick={onFolder} title={`${folder ?? ''} — ${t('f_change')}`}>
                {(folder ?? host?.folder ?? '').split(/[\/]/).filter(Boolean).pop() ?? ''} <Icon name="chevron" size={11} className="chev open" />
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
          <Icon name="search" size={15} />
          <span>{t('pal_short')}</span>
          <span className="kbds"><kbd>Ctrl</kbd><kbd>K</kbd></span>
        </button>

        <div className="sidebar-scroll">
          {sessions.length === 0 ? <p className="muted pad">{t('noSessions')}</p> : null}
          {mine.length ? (
            <>
              <h3>{owner ? t('yourSessions') : t('sharedWithYou')}</h3>
              <ul>{mine.map((s) => <Item key={s.id} s={s} active={s.id === activeId} onOpen={(id) => go({ page: 'session', id })} />)}</ul>
            </>
          ) : null}
          {others.length ? (
            <>
              <h3>{owner ? t('guests') : t('yourSessions')}</h3>
              <ul>{others.map((s) => <Item key={s.id} s={s} active={s.id === activeId} onOpen={(id) => go({ page: 'session', id })} />)}</ul>
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
