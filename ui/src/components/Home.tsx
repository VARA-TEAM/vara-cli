import { useState } from 'react'
import { api } from '../api'
import type { Cmd } from '../commands'
import { useResource } from '../hooks'
import { useT } from '../i18n'
import { relativeTime } from '../transcript'
import type { Me, ModeRow, ModelsInfo, ProvidersState, SessionSummary, SessionView } from '../types'
import { Composer } from './Composer'
import type { Route } from './Sidebar'
import { useToast } from './toast'
import { Button, Icon, StateBadge } from './ui'

const SUGGESTIONS = ['Explain how this project is organised', 'Find and fix the failing tests', 'Review my latest changes', 'Keep the build green and tell me when it breaks']

/** The start screen: type anything, nothing else is required. */
export function Home({ me, models, sessions, commands, go, onOpen, onToggleSidebar }: { me: Me; models: ModelsInfo | null; sessions: SessionSummary[]; commands: Cmd[]; go: (r: Route) => void; onOpen: (id: string) => void; onToggleSidebar: () => void }) {
  const t = useT()
  const toast = useToast()
  const owner = me.role === 'owner'
  const providers = useResource<ProvidersState>(owner ? '/api/manage/providers' : null)
  const activeP = providers.data?.providers.find((p) => p.active)
  const needsKey = !!activeP && activeP.key === 'none'
  const [kind, setKind] = useState<'auto' | 'task' | 'goal'>('auto')
  const guest = me.role === 'guest' ? me : null
  const canCreate = !guest || guest.grant.ownSession
  const customModes = useResource<ModeRow[]>(owner ? '/api/manage/modes' : null)
  const [mode, setMode] = useState<string>(guest ? guest.grant.mode : 'build')
  const [model, setModel] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const canPickMode = !guest || (guest.grant.canChangeMode && guest.grant.mode === 'build')
  const modelList = models && models.allowed !== 'any' ? models.allowed : []
  const canPickModel = !guest || guest.grant.modelPolicy !== 'locked'
  const recent = sessions.slice(0, 6)

  const create = async (message: string): Promise<void> => {
    setError(null)
    try {
      const v = await api<SessionView>('POST', '/api/sessions', { message, kind, mode, ...(model ? { model } : {}) })
      onOpen(v.id)
    } catch (e) {
      setError((e as Error).message)
      throw e
    }
  }

  return (
    <main className="home">
      <header className="home-head only-narrow">
        <button className="icon-btn" onClick={onToggleSidebar} aria-label={t('sessions')}>
          <Icon name="menu" />
        </button>
      </header>
      <div className="home-inner">
        <div className="logo-mark" aria-hidden="true">
          <svg viewBox="0 0 64 64" width="56" height="56">
            <rect width="64" height="64" rx="16" fill="var(--surface-2)" />
            <path d="M12 18l13 30 13-30" fill="none" stroke="var(--brand)" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M40 48l6-14 6 14M42.4 43h7.2" fill="none" stroke="var(--accent)" strokeWidth="4.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h1>{t('home_title')}</h1>
        <p className="muted">{t('home_sub')}</p>

        {needsKey ? (
          <div className="setup-note" role="alert">
            <Icon name="alert" size={18} />
            <div>
              <strong>{t('onb_title', { p: activeP!.label })}</strong>
              <span className="muted">{t('onb_body')}</span>
            </div>
            <Button kind="primary" onClick={() => go({ page: 'settings', tab: 'models' })}>
              {t('onb_cta')}
            </Button>
          </div>
        ) : null}

        {canCreate ? (
          <>
            <Composer
              big
              autoFocus
              draftKey="home"
              commands={commands}
              files={owner}
              onUnknownCommand={(n) => toast(t('cmd_unknown', { n }), 'err')}
              onSend={create}
              controls={
                <>
                  <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label={t('kind')}>
                    <option value="auto">{t('kind_auto')}</option>
                    <option value="task">{t('kind_task')}</option>
                    <option value="goal">{t('kind_goal')}</option>
                  </select>
                  {canPickMode ? (
                    <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label={t('mode')}>
                      <option value="plan">{t('mode_plan')}</option>
                      <option value="build">{t('mode_build')}</option>
                      {(customModes.data ?? []).map((m) => (
                        <option key={m.name} value={m.name}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="chip" title={t('mode')}>
                      {mode === 'plan' ? t('mode_plan') : mode === 'build' ? t('mode_build') : mode}
                    </span>
                  )}
                  {canPickModel && modelList.length > 1 ? (
                    <select value={model} onChange={(e) => setModel(e.target.value)} aria-label={t('model')}>
                      <option value="">{models?.current}</option>
                      {modelList
                        .filter((m) => m !== models?.current)
                        .map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                    </select>
                  ) : (
                    <span className="chip mono" title={t('model')}>
                      {models?.allowed === 'any' || !guest ? (model || models?.current) : models?.current}
                    </span>
                  )}
                </>
              }
            />
            {error ? <div className="inline-error" role="alert">{error}</div> : null}
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="suggestion" dir="auto" onClick={() => void create(s).catch(() => {})}>
                  {s}
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="notice">{t('guestBanner_viewer')}</div>
        )}

        {recent.length ? (
          <section className="recent">
            <h2>{t('sessions')}</h2>
            <ul>
              {recent.map((s) => (
                <li key={s.id}>
                  <button onClick={() => onOpen(s.id)}>
                    <span dir="auto" className="recent-title">
                      {s.objective}
                    </span>
                    <span className="recent-meta">
                      {s.participant ? <span className="muted">{s.participant.name}</span> : null}
                      <StateBadge state={s.state} />
                      <span className="muted">{relativeTime(s.updatedAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </main>
  )
}
