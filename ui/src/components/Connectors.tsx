import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useT } from '../i18n'
import { useAct } from './toast'
import { Badge, Button, Dialog, Field, Icon, Switch } from './ui'

export interface ConnectorRow {
  id: string
  name: string
  category: string
  description: string
  checked: string
  secrets: Array<{ name: string; label: string; help: string; stored: boolean }>
  added: boolean
  enabled: boolean
  status: 'disabled' | 'connecting' | 'ready' | 'error' | null
  tools: number
  error: string
  /** Present for services that sign in with a browser. Never holds a token. */
  oauth?: { client: 'dynamic' | 'registered'; signedIn: boolean; canRefresh: boolean; expiresAt?: number; login: { state: 'pending' | 'done' | 'error'; error: string } | null }
}

const BASE = '/api/manage/connectors'

function ConnectDialog({ c, onClose, onDone }: { c: ConnectorRow; onClose: () => void; onDone: (rows: ConnectorRow[]) => void }) {
  const t = useT()
  const { busy, act } = useAct()
  const [values, setValues] = useState<Record<string, string>>({})
  const missing = c.secrets.filter((s) => !s.stored && !values[s.name]?.trim())
  return (
    <Dialog title={t('cn_connect_title', { n: c.name })} onClose={onClose}>
      <p className="muted">{c.description}</p>
      {c.secrets.length === 0 ? <p>{t('cn_nosecret')}</p> : null}
      {c.secrets.map((s) => (
        <Field key={s.name} label={s.label} hint={s.stored ? t('cn_stored') : s.help}>
          <input type="password" autoComplete="off" spellCheck={false} dir="ltr" value={values[s.name] ?? ''} placeholder={s.stored ? t('p_replaceKey') : t('p_keyPlaceholder')} onChange={(e) => setValues({ ...values, [s.name]: e.target.value })} />
        </Field>
      ))}
      <p className="muted small">{c.checked}</p>
      <div className="dialog-foot">
        <Button kind="ghost" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button kind="primary" disabled={missing.length > 0 || !!busy} onClick={() => void act('add', () => api<ConnectorRow[]>('POST', BASE, { id: c.id, secrets: values }), t('m_added')).then((r) => r && (onDone(r), onClose()))}>
          {t('m_connect')}
        </Button>
      </div>
    </Dialog>
  )
}

/** Browser sign-in (OAuth): open the service's page, wait for the answer, or paste the address when the browser is on another machine. */
function SignInDialog({ c, onClose, onDone }: { c: ConnectorRow; onClose: () => void; onDone: (rows: ConnectorRow[]) => void }) {
  const t = useT()
  const [authUrl, setAuthUrl] = useState('')
  const [redirect, setRedirect] = useState('')
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)
  const [pasted, setPasted] = useState('')
  const alive = useRef(true)
  const finished = useRef(false)
  const base = `${BASE}/${encodeURIComponent(c.id)}/login`
  const finish = (): void => {
    if (finished.current) return
    finished.current = true
    void api<ConnectorRow[]>('GET', BASE).then((rows) => {
      onDone(rows)
      onClose()
    })
  }
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (!finished.current) void api('DELETE', base).catch(() => {})
    }
  }, [base])
  useEffect(() => {
    if (!authUrl) return
    const timer = window.setInterval(() => {
      void api<{ state: string; error: string }>('GET', base)
        .then((s) => {
          if (!alive.current) return
          if (s.state === 'done') finish()
          else if (s.state === 'error') setError(s.error)
        })
        .catch(() => {})
    }, 1500)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUrl])
  const start = async (): Promise<void> => {
    setError('')
    setStarting(true)
    // Opened synchronously so the browser's pop-up blocker lets it through; pointed at the service once we have the address.
    const w = window.open('', '_blank')
    try {
      const r = await api<{ authUrl: string; redirectUri: string }>('POST', base, {})
      setAuthUrl(r.authUrl)
      setRedirect(r.redirectUri)
      if (w) w.location.href = r.authUrl
    } catch (e) {
      w?.close()
      setError((e as Error).message)
    } finally {
      setStarting(false)
    }
  }
  const submit = async (): Promise<void> => {
    setError('')
    try {
      await api('POST', `${base}/code`, { pasted })
      finish()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <Dialog title={t('cn_signin_title', { n: c.name })} onClose={onClose}>
      <p className="muted">{c.description}</p>
      {c.oauth?.client === 'registered' ? <p className="muted small">{t('cn_oauth_registered')}</p> : null}
      {!authUrl ? (
        <Button kind="primary" disabled={starting} onClick={() => void start()}>
          {t('cn_signin_open')}
        </Button>
      ) : (
        <>
          <p>{t('cn_signin_wait')}</p>
          <p className="small" dir="ltr">
            <a href={authUrl} target="_blank" rel="noopener noreferrer">
              {t('cn_signin_link')}
            </a>
          </p>
          <Field label={t('cn_signin_paste')} hint={t('cn_signin_paste_hint', { u: redirect })}>
            <input type="text" autoComplete="off" spellCheck={false} dir="ltr" value={pasted} placeholder={redirect} onChange={(e) => setPasted(e.target.value)} />
          </Field>
          <Button disabled={!pasted.trim()} onClick={() => void submit()}>
            {t('cn_signin_submit')}
          </Button>
        </>
      )}
      {error ? (
        <p className="model-err" role="alert" dir="auto">
          {error}
        </p>
      ) : null}
      <p className="muted small">{c.checked}</p>
      <div className="dialog-foot">
        <Button kind="ghost" onClick={onClose}>
          {t('cancel')}
        </Button>
      </div>
    </Dialog>
  )
}

/** Settings → Connectors: ready-made MCP servers with guided secrets. */
export function ConnectorsPanel({ rows, set }: { rows: ConnectorRow[] | null; set: (r: ConnectorRow[]) => void }) {
  const t = useT()
  const { act } = useAct()
  const [pick, setPick] = useState<ConnectorRow | null>(null)
  const [signIn, setSignIn] = useState<ConnectorRow | null>(null)
  if (!rows) return <p className="muted pad">{t('loading')}</p>
  const reload = (): Promise<void> => api<ConnectorRow[]>('GET', BASE).then(set)
  return (
    <div>
      <p className="lede">{t('cn_sub')}</p>
      <ul className="rows">
        {rows.map((c) => (
          <li key={c.id} className={`rowitem${c.added && !c.enabled ? ' is-off' : ''}`}>
            {c.added ? <span className={`dot dot-mcp-${c.status ?? 'connecting'}`} role="img" aria-label={c.status ?? ''} /> : <Icon name="link" size={16} />}
            <div className="rowitem-main">
              <div className="rowitem-title">
                <strong>{c.name}</strong>
                <Badge tone="muted">{t(`cn_cat_${c.category}` as 'cn_cat_code')}</Badge>
                {c.oauth ? <Badge tone={c.oauth.signedIn ? 'ok' : 'muted'}>{c.oauth.signedIn ? t('cn_signedin') : t('cn_signin_needed')}</Badge> : null}
                {c.added && c.status === 'ready' ? <span className="muted">{t('m_tools', { n: c.tools })}</span> : null}
                {c.added && c.status === 'error' ? <span className="model-err" dir="auto">{c.error}</span> : null}
              </div>
              <span className="muted" dir="auto">{c.description}</span>
            </div>
            {c.added ? (
              <>
                {c.oauth?.signedIn ? (
                  <Button small kind="ghost" onClick={() => void act('out', () => api('POST', `${BASE}/${encodeURIComponent(c.id)}/logout`), t('cn_signedout')).then(reload)}>
                    {t('cn_signout')}
                  </Button>
                ) : c.oauth ? (
                  <Button small onClick={() => setSignIn(c)}>
                    {t('cn_signin')}
                  </Button>
                ) : null}
                <button className="icon-btn" aria-label={t('remove')} title={t('remove')} onClick={() => void act('rm', () => api('DELETE', `/api/manage/mcp/${encodeURIComponent(c.id)}`)).then(reload)}>
                  <Icon name="trash" size={15} />
                </button>
                <Switch checked={c.enabled} onChange={(v) => void act('en', () => api('PATCH', `/api/manage/mcp/${encodeURIComponent(c.id)}`, { enabled: v })).then(reload)} label={<span className="sr-only">{c.name}</span>} />
              </>
            ) : c.oauth ? (
              <Button small onClick={() => setSignIn(c)}>
                {t('cn_signin')}
              </Button>
            ) : (
              <Button small onClick={() => setPick(c)}>
                {t('cn_add')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <p className="muted small">{t('cn_note')}</p>
      {signIn ? <SignInDialog c={signIn} onClose={() => setSignIn(null)} onDone={set} /> : null}
      {pick ? <ConnectDialog c={pick} onClose={() => setPick(null)} onDone={set} /> : null}
    </div>
  )
}
