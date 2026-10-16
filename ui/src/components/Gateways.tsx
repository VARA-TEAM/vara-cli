import { useContext, useEffect, useState } from 'react'
import { api } from '../api'
import { LangContext, useT } from '../i18n'
import { useAct } from './toast'
import { Badge, Button, Field, Switch } from './ui'

interface L {
  en: string
  ar: string
}

export interface GatewayRow {
  id: string
  name: string
  intro: L
  steps: L[]
  fields: Array<{ name: string; label: L; help: L; stored: boolean }>
  enabled: boolean
  running: boolean
  paired: boolean
  pairing?: { code: string; expiresAt: number }
  bot?: string
}
export interface GatewayState {
  providers: GatewayRow[]
}

const BASE = '/api/manage/gateways'

function Card({ g, now, onState }: { g: GatewayRow; now: number; onState: (s: GatewayState) => void }) {
  const t = useT()
  const { lang } = useContext(LangContext)
  const { busy, act } = useAct()
  const [values, setValues] = useState<Record<string, string>>({})
  const left = g.pairing ? Math.max(0, Math.round((g.pairing.expiresAt - now) / 1000)) : 0
  const ready = g.fields.every((f) => f.stored || values[f.name]?.trim())
  const hasSecrets = g.fields.every((f) => f.stored)
  const reload = (): Promise<void> => api<GatewayState>('GET', BASE).then(onState)
  return (
    <section className="rowitem" style={{ display: 'block', marginBottom: 18 }}>
      <div className="rowitem-title">
        <h2 className="sub" style={{ margin: 0 }}>
          {g.name}
        </h2>
        <Badge tone={g.running ? 'ok' : 'muted'}>{g.running ? t('gw_running') : t('gw_stopped')}</Badge>
        {g.paired ? <Badge tone="ok">{t('gw_paired')}</Badge> : null}
        {g.bot ? <Badge tone="accent">{t('gw_tokenOk', { n: g.bot })}</Badge> : null}
      </div>
      <p className="muted" dir="auto">
        {g.intro[lang]}
      </p>
      <ol className="small" dir="auto" style={{ paddingInlineStart: 20 }}>
        {g.steps.map((s) => (
          <li key={s.en}>{s[lang]}</li>
        ))}
      </ol>

      {g.fields.map((f) => (
        <Field key={f.name} label={f.label[lang]} hint={f.stored ? t('cn_stored') : f.help[lang]}>
          <input type="password" autoComplete="off" spellCheck={false} dir="ltr" value={values[f.name] ?? ''} placeholder={f.stored ? t('p_replaceKey') : ''} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
        </Field>
      ))}
      <Button
        kind="primary"
        disabled={!ready || busy !== null || !Object.values(values).some((v) => v.trim())}
        onClick={() =>
          void act('secrets', () => api<GatewayState>('POST', `${BASE}/${g.id}/secrets`, { secrets: values }), t('gw_tokenSaved')).then((s) => {
            if (s) (setValues({}), onState(s))
          })
        }
      >
        {t('gw_saveToken')}
      </Button>

      <div style={{ marginTop: 14 }}>
        <strong>{t('gw_pairTitle')}</strong>
        {g.paired ? (
          <div>
            <Button kind="ghost" disabled={busy !== null} onClick={() => void act('unpair', () => api('POST', `${BASE}/${g.id}/unpair`), t('gw_unpaired')).then(reload)}>
              {t('gw_unpair')}
            </Button>
          </div>
        ) : (
          <div>
            {g.pairing && left > 0 ? (
              <p>
                <code className="mono" dir="ltr" style={{ fontSize: 18 }}>
                  pair {g.pairing.code}
                </code>{' '}
                <span className="muted small">{t('gw_expires', { n: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` })}</span>
              </p>
            ) : (
              <p className="muted small">{t('gw_step2Help')}</p>
            )}
            <Button disabled={!hasSecrets || busy !== null} onClick={() => void act('pair', () => api('POST', `${BASE}/${g.id}/pair`)).then(reload)}>
              {g.pairing && left > 0 ? t('gw_newCode') : t('gw_makeCode')}
            </Button>
          </div>
        )}
      </div>

      <div style={{ marginTop: 14 }}>
        <Switch checked={g.enabled} disabled={!hasSecrets || busy !== null} label={t('gw_enable', { n: g.name })} onChange={(v) => void act('enable', () => api<GatewayState>('POST', `${BASE}/${g.id}/enable`, { enabled: v })).then((s) => s && onState(s))} />
      </div>
    </section>
  )
}

/** Settings → Gateways: every messaging platform VARA can be reached from; the person sets up the ones they use. */
export function GatewaysPanel({ state, set }: { state: GatewayState | null; set: (s: GatewayState) => void }) {
  const t = useT()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  if (!state) return <p className="muted pad">{t('loading')}</p>
  return (
    <div>
      <p className="lede">{t('gw_sub')}</p>
      {state.providers.map((g) => (
        <Card key={g.id} g={g} now={now} onState={set} />
      ))}
      <p className="muted small">{t('gw_safety')}</p>
    </div>
  )
}
