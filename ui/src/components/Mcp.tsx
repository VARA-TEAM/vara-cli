import { useEffect, useState } from 'react'
import { api } from '../api'
import { useT } from '../i18n'
import type { McpServerRow, McpState } from '../types'
import { useAct } from './toast'
import { Badge, Button, Dialog, Field, Icon, Switch } from './ui'

const BASE = '/api/manage/mcp'

function AddDialog({ state, onClose, onAdded }: { state: McpState; onClose: () => void; onAdded: (s: McpState) => void }) {
  const t = useT()
  const { busy, act } = useAct()
  const [name, setName] = useState('')
  const [input, setInput] = useState('')
  const add = async (body: unknown): Promise<void> => {
    const r = await act('add', () => api<McpState>('POST', BASE, body), t('m_added'))
    if (r) (onAdded(r), onClose())
  }
  return (
    <Dialog title={t('m_add')} onClose={onClose} wide>
      <h3 className="sec first">{t('m_quick')}</h3>
      <div className="preset-grid">
        {state.presets.map((p) => (
          <button key={p.name} className="preset" disabled={p.added || !!busy} onClick={() => void add({ preset: p.name })}>
            <strong>{p.label}</strong>
            <span className="muted">{p.added ? t('p_addedAlready') : p.note}</span>
          </button>
        ))}
      </div>
      <h3 className="sec">{t('m_custom')}</h3>
      <div className="two">
        <Field label={t('p_name')} hint="docs">
          <input value={name} onChange={(e) => setName(e.target.value)} dir="ltr" maxLength={31} />
        </Field>
        <Field label={t('m_commandOrUrl')} hint={t('m_commandHint')}>
          <input value={input} onChange={(e) => setInput(e.target.value)} dir="ltr" placeholder="npx -y @scope/server  ·  https://…" />
        </Field>
      </div>
      <div className="dialog-foot">
        <Button kind="ghost" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button kind="primary" disabled={!name.trim() || !input.trim() || !!busy} onClick={() => void add({ name: name.trim(), input: input.trim() })}>
          {t('m_connect')}
        </Button>
      </div>
    </Dialog>
  )
}

function Server({ s, set }: { s: McpServerRow; set: (m: McpState) => void }) {
  const t = useT()
  const { busy, act } = useAct()
  const [tools, setTools] = useState(false)
  const url = `${BASE}/${encodeURIComponent(s.name)}`
  return (
    <li className="rowitem server">
      <span className={`dot dot-mcp-${s.status}`} role="img" aria-label={t(`m_st_${s.status}` as 'm_st_ready')} title={t(`m_st_${s.status}` as 'm_st_ready')} />
      <div className="rowitem-main">
        <div className="rowitem-title">
          <strong className="mono" dir="ltr">{s.name}</strong>
          <Badge tone="muted">{s.kind === 'remote' ? t('m_remote') : t('m_local')}</Badge>
          {s.status === 'ready' ? (
            <button className="link-btn" onClick={() => setTools((o) => !o)} aria-expanded={tools}>
              {t('m_tools', { n: s.tools })}
            </button>
          ) : (
            <span className="muted">{t(`m_st_${s.status}` as 'm_st_ready')}</span>
          )}
        </div>
        <span className="muted mono clip" dir="ltr">{s.target}</span>
        {s.status === 'error' && s.error ? <span className="model-err" dir="auto">{s.error}</span> : null}
        {tools ? (
          <ul className="tool-list" dir="ltr">
            {s.toolList.map((x) => (
              <li key={x.name}>
                <span className="mono">{x.name}</span>
                <span className="muted clip">{x.description}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <Button small kind="ghost" onClick={() => void act('re', () => api<McpState>('PATCH', url, { reconnect: true })).then((r) => r && set(r))} disabled={!!busy || !s.enabled}>
        {t('m_reconnect')}
      </Button>
      <button className="icon-btn" aria-label={t('remove')} title={t('remove')} disabled={!!busy} onClick={() => void act('rm', () => api<McpState>('DELETE', url)).then((r) => r && set(r))}>
        <Icon name="trash" size={15} />
      </button>
      <Switch checked={s.enabled} onChange={(v) => void act('en', () => api<McpState>('PATCH', url, { enabled: v })).then((r) => r && set(r))} label={<span className="sr-only">{s.name}</span>} />
    </li>
  )
}

/** Settings → MCP servers: extra tools for the agent from local programs or remote services. */
export function McpPanel({ state, set, reload }: { state: McpState | null; set: (s: McpState) => void; reload: () => void }) {
  const t = useT()
  const [adding, setAdding] = useState(false)
  // Servers connect in the background: keep looking until none is still connecting.
  const connecting = state?.servers.some((s) => s.status === 'connecting') ?? false
  useEffect(() => {
    if (!connecting) return
    const id = setInterval(reload, 1500)
    return () => clearInterval(id)
  }, [connecting, reload])
  if (!state) return <p className="muted pad">{t('loading')}</p>
  return (
    <div>
      <div className="lede-row">
        <p className="lede">{t('m_sub')}</p>
        <Button icon="plus" onClick={() => setAdding(true)}>
          {t('m_add')}
        </Button>
      </div>
      {state.servers.length ? (
        <ul className="rows">
          {state.servers.map((s) => (
            <Server key={s.name} s={s} set={set} />
          ))}
        </ul>
      ) : (
        <div className="empty-block">
          <Icon name="link" size={22} />
          <p>{t('m_empty')}</p>
        </div>
      )}
      <p className="muted small">{t('m_secretsNote')}</p>
      {adding ? <AddDialog state={state} onClose={() => setAdding(false)} onAdded={set} /> : null}
    </div>
  )
}
