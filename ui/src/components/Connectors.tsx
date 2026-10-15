import { useState } from 'react'
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

/** Settings → Connectors: ready-made MCP servers with guided secrets. */
export function ConnectorsPanel({ rows, set }: { rows: ConnectorRow[] | null; set: (r: ConnectorRow[]) => void }) {
  const t = useT()
  const { act } = useAct()
  const [pick, setPick] = useState<ConnectorRow | null>(null)
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
                {c.added && c.status === 'ready' ? <span className="muted">{t('m_tools', { n: c.tools })}</span> : null}
                {c.added && c.status === 'error' ? <span className="model-err" dir="auto">{c.error}</span> : null}
              </div>
              <span className="muted" dir="auto">{c.description}</span>
            </div>
            {c.added ? (
              <>
                <button className="icon-btn" aria-label={t('remove')} title={t('remove')} onClick={() => void act('rm', () => api('DELETE', `/api/manage/mcp/${encodeURIComponent(c.id)}`)).then(reload)}>
                  <Icon name="trash" size={15} />
                </button>
                <Switch checked={c.enabled} onChange={(v) => void act('en', () => api('PATCH', `/api/manage/mcp/${encodeURIComponent(c.id)}`, { enabled: v })).then(reload)} label={<span className="sr-only">{c.name}</span>} />
              </>
            ) : (
              <Button small onClick={() => setPick(c)}>
                {t('cn_add')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <p className="muted small">{t('cn_note')}</p>
      {pick ? <ConnectDialog c={pick} onClose={() => setPick(null)} onDone={set} /> : null}
    </div>
  )
}
