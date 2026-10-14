import { useContext, useState } from 'react'
import { ApiError, api, auth } from '../api'
import { LangContext, useT, type Lang } from '../i18n'
import { THEMES, type Theme } from '../theme'
import type { Grant, Me } from '../types'
import { Button, Field, Icon } from './ui'

/** Shown when the page is opened without a link that carries access. */
export function SignIn() {
  const t = useT()
  return (
    <div className="center-screen">
      <div className="card narrow">
        <div className="logo-mark" aria-hidden="true">
          <svg viewBox="0 0 64 64" width="48" height="48">
            <rect width="64" height="64" rx="16" fill="var(--surface-2)" />
            <path d="M12 18l13 30 13-30" fill="none" stroke="var(--brand)" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M40 48l6-14 6 14M42.4 43h7.2" fill="none" stroke="var(--accent)" strokeWidth="4.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h1>{t('signin_title')}</h1>
        <p className="muted">{t('signin_body')}</p>
        <pre className="cmd" dir="ltr">vara ui</pre>
      </div>
    </div>
  )
}

/** /join/<token>: pick a name and enter. */
export function Join({ invite, onJoined }: { invite: string; onJoined: () => void }) {
  const t = useT()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ accessToken: string }>('POST', '/api/join', { invite, name: name.trim() || 'guest' }, { anonymous: true })
      auth.set(r.accessToken, 'local')
      history.replaceState(null, '', '/')
      onJoined()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('join_failed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="center-screen">
      <form
        className="card narrow"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="logo-mark" aria-hidden="true">
          <svg viewBox="0 0 64 64" width="48" height="48">
            <rect width="64" height="64" rx="16" fill="var(--surface-2)" />
            <path d="M12 18l13 30 13-30" fill="none" stroke="var(--brand)" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M40 48l6-14 6 14M42.4 43h7.2" fill="none" stroke="var(--accent)" strokeWidth="4.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h1>{t('join_title')}</h1>
        <p className="muted">{t('join_body')}</p>
        <Field label={t('join_name')}>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoFocus dir="auto" autoComplete="nickname" />
        </Field>
        {error ? <div className="inline-error" role="alert">{error}</div> : null}
        <Button type="submit" kind="primary" disabled={busy}>
          {t('join_button')}
        </Button>
      </form>
    </div>
  )
}

function describeGrant(g: Grant, t: ReturnType<typeof useT>): string[] {
  const out: string[] = []
  if (g.watch) out.push(t('canWatch'))
  if (g.sendShared) out.push(t('canSendShared'))
  if (g.ownSession) out.push(t('canOwn'))
  out.push(g.mode === 'plan' ? t('readonlyAgent') : t('yourAgentBuild'))
  if (g.maxModelCalls) out.push(`${t('maxCalls')}: ${g.maxModelCalls}`)
  if (g.maxCostUsd) out.push(`${t('maxCost')}: ${g.maxCostUsd}`)
  return out
}

export function Settings({ me, theme, onTheme, onToggleSidebar }: { me: Me; theme: Theme; onTheme: (t: Theme) => void; onToggleSidebar: () => void }) {
  const t = useT()
  const { lang, setLang } = useContext(LangContext)
  return (
    <main className="page">
      <header className="page-head">
        <button className="icon-btn only-narrow" onClick={onToggleSidebar} aria-label={t('sessions')}>
          <Icon name="menu" />
        </button>
        <h1>{t('settings')}</h1>
      </header>

      <section className="card">
        <h2>{t('theme')}</h2>
        <div className="theme-grid" role="radiogroup" aria-label={t('theme')}>
          {THEMES.map((th) => (
            <button key={th.id} role="radio" aria-checked={th.id === theme.id} className={`theme-card${th.id === theme.id ? ' on' : ''}`} onClick={() => onTheme(th)}>
              <span className="swatch" style={{ background: th.bg, borderColor: th.border }}>
                <i style={{ background: th.brand }} />
                <i style={{ background: th.accent }} />
                <i style={{ background: th.user }} />
              </span>
              {th.label}
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>{t('language')}</h2>
        <div className="seg" role="radiogroup" aria-label={t('language')}>
          {(['en', 'ar'] as Lang[]).map((l) => (
            <button key={l} role="radio" aria-checked={lang === l} className={lang === l ? 'on' : ''} onClick={() => setLang(l)}>
              {l === 'en' ? 'English' : 'العربية'}
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>{t('host')}</h2>
        <dl className="kv wide">
          <dt>{t('folder')}</dt>
          <dd className="mono" dir="ltr">{me.host.folder}</dd>
          <dt>{t('provider')}</dt>
          <dd className="mono" dir="ltr">
            {me.host.provider} · {me.host.model}
          </dd>
          <dt>{t('version')}</dt>
          <dd className="mono">{me.host.version}</dd>
        </dl>
        {me.role === 'owner' ? <p className="muted">{t('providerHint')}</p> : null}
        {me.role === 'guest' ? (
          <>
            <h3>{t('youAre')} {me.name}</h3>
            <ul className="plain">
              {describeGrant(me.grant, t).map((s) => (
                <li key={s}>
                  <Icon name="check" size={14} /> {s}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
    </main>
  )
}
