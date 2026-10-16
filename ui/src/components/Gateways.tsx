import { useEffect, useState } from 'react'
import { api } from '../api'
import { useT } from '../i18n'
import { useAct } from './toast'
import { Badge, Button, Field, Switch } from './ui'

export interface GatewayState {
  telegram: { hasToken: boolean; enabled: boolean; running: boolean; paired: boolean; pairing?: { code: string; expiresAt: number }; bot?: string }
}

const BASE = '/api/manage/gateways'

/** Settings → Gateways: reach VARA from a messaging app. Telegram is three plain steps: token, pair, on. */
export function GatewaysPanel({ state, set }: { state: GatewayState | null; set: (s: GatewayState) => void }) {
  const t = useT()
  const { busy, act } = useAct()
  const [token, setToken] = useState('')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  if (!state) return <p className="muted pad">{t('loading')}</p>
  const tg = state.telegram
  const left = tg.pairing ? Math.max(0, Math.round((tg.pairing.expiresAt - now) / 1000)) : 0
  const reload = (): Promise<void> => api<GatewayState>('GET', BASE).then(set)
  return (
    <div>
      <p className="lede">{t('gw_sub')}</p>
      <h2 className="sub">Telegram</h2>
      <div className="rowitem" style={{ display: 'block' }}>
        <div className="rowitem-title">
          <strong>{t('gw_step1')}</strong>
          {tg.hasToken ? <Badge tone="ok">{tg.bot ? t('gw_tokenOk', { n: tg.bot }) : t('gw_tokenSet')}</Badge> : <Badge tone="muted">{t('gw_noToken')}</Badge>}
        </div>
        <p className="muted small">{t('gw_step1Help')}</p>
        <Field label={t('gw_token')} hint={tg.hasToken ? t('cn_stored') : undefined}>
          <input type="password" autoComplete="off" spellCheck={false} dir="ltr" value={token} placeholder={tg.hasToken ? t('p_replaceKey') : '123456789:AA…'} onChange={(e) => setToken(e.target.value)} />
        </Field>
        <Button
          kind="primary"
          disabled={!token.trim() || busy !== null}
          onClick={() =>
            void act('token', () => api<GatewayState>('POST', `${BASE}/telegram/token`, { token: token.trim() }), t('gw_tokenSaved')).then((s) => {
              if (s) (setToken(''), set(s))
            })
          }
        >
          {t('gw_saveToken')}
        </Button>
      </div>

      <div className="rowitem" style={{ display: 'block', marginTop: 12 }}>
        <div className="rowitem-title">
          <strong>{t('gw_step2')}</strong>
          {tg.paired ? <Badge tone="ok">{t('gw_paired')}</Badge> : <Badge tone="muted">{t('gw_notPaired')}</Badge>}
        </div>
        {tg.paired ? (
          <Button kind="ghost" disabled={busy !== null} onClick={() => void act('unpair', () => api('POST', `${BASE}/telegram/unpair`), t('gw_unpaired')).then(reload)}>
            {t('gw_unpair')}
          </Button>
        ) : (
          <>
            <p className="muted small">{t('gw_step2Help')}</p>
            {tg.pairing && left > 0 ? (
              <p>
                <code className="mono" dir="ltr" style={{ fontSize: 18 }}>
                  /pair {tg.pairing.code}
                </code>{' '}
                <span className="muted small">{t('gw_expires', { n: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` })}</span>
              </p>
            ) : null}
            <Button disabled={!tg.hasToken || busy !== null} onClick={() => void act('pair', () => api('POST', `${BASE}/telegram/pair`)).then(reload)}>
              {tg.pairing && left > 0 ? t('gw_newCode') : t('gw_makeCode')}
            </Button>
          </>
        )}
      </div>

      <div className="rowitem" style={{ display: 'block', marginTop: 12 }}>
        <div className="rowitem-title">
          <strong>{t('gw_step3')}</strong>
          <Badge tone={tg.running ? 'ok' : 'muted'}>{tg.running ? t('gw_running') : t('gw_stopped')}</Badge>
        </div>
        <Switch checked={tg.enabled} disabled={!tg.hasToken || busy !== null} label={t('gw_enable')} onChange={(v) => void act('enable', () => api<GatewayState>('POST', `${BASE}/telegram/enable`, { enabled: v })).then((s) => s && set(s))} />
      </div>
      <p className="muted small" style={{ marginTop: 12 }}>
        {t('gw_safety')}
      </p>
    </div>
  )
}
