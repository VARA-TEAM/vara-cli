import { useEffect, useState } from 'react'
import { api } from '../api'
import { useT } from '../i18n'
import { relativeTime, formatTokens } from '../transcript'
import type { ModelRow, PresetRow, ProviderRow, ProvidersState, ThinkLevel } from '../types'
import { useAct, useToast } from './toast'
import { Badge, Button, Dialog, Field, Icon, Switch } from './ui'

const BASE = '/api/manage/providers'

function Dot({ status, title }: { status: ModelRow['status']; title: string }) {
  return <span className={`dot dot-${status}`} title={title} role="img" aria-label={title} />
}

function KeyChip({ p }: { p: ProviderRow }) {
  const t = useT()
  if (p.key === 'not needed') return <Badge tone="muted">{t('p_key_notneeded')}</Badge>
  if (p.key === 'vault') return <Badge tone="ok"><Icon name="shield" size={12} /> {t('p_key_vault')}</Badge>
  if (p.key === 'env') return <Badge tone="ok">{t('p_key_env')}</Badge>
  return <Badge tone="warn"><Icon name="alert" size={12} /> {t('p_key_none')}</Badge>
}

function ContextDialog({ provider, model, onClose, onSaved }: { provider: string; model: ModelRow; onClose: () => void; onSaved: (s: ProvidersState) => void }) {
  const t = useT()
  const { busy, act } = useAct()
  const [win, setWin] = useState(String(model.contextTokens))
  const [out, setOut] = useState(model.maxOutputTokens ? String(model.maxOutputTokens) : '')
  const parse = (v: string): number | null | undefined => {
    const x = v.trim().toLowerCase().replace(/[,_\s]/g, '')
    if (!x) return null
    const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(x)
    if (!m) return undefined
    return Math.round(Number(m[1]) * (m[2] === 'm' ? 1_000_000 : m[2] === 'k' ? 1_000 : 1))
  }
  const w = parse(win)
  const o = parse(out)
  const save = async (reset = false): Promise<void> => {
    const body = reset ? { contextWindow: null, maxOutputTokens: null } : { contextWindow: w ?? null, maxOutputTokens: o ?? null }
    const r = await act('ctx', () => api<ProvidersState>('POST', `${BASE}/${encodeURIComponent(provider)}/model`, { action: 'context', id: model.id, ...body }), t('saved'))
    if (r) (onSaved(r), onClose())
  }
  return (
    <Dialog title={<span className="mono" dir="ltr">{model.id}</span>} onClose={onClose}>
      <p className="muted">{t('p_contextHelp')}</p>
      <Field label={t('p_window')} hint={t('p_windowHint')}>
        <input value={win} onChange={(e) => setWin(e.target.value)} inputMode="numeric" dir="ltr" placeholder="128k" />
      </Field>
      <Field label={t('p_output')} hint={t('p_outputHint')}>
        <input value={out} onChange={(e) => setOut(e.target.value)} inputMode="numeric" dir="ltr" placeholder={t('p_auto')} />
      </Field>
      <div className="dialog-foot">
        <Button kind="ghost" onClick={() => void save(true)} disabled={!!busy}>
          {t('p_resetAuto')}
        </Button>
        <Button kind="primary" onClick={() => void save()} disabled={!!busy || w === undefined || o === undefined}>
          {t('save')}
        </Button>
      </div>
    </Dialog>
  )
}

function AddProviderDialog({ state, onClose, onAdded }: { state: ProvidersState; onClose: () => void; onAdded: (s: ProvidersState, name: string) => void }) {
  const t = useT()
  const { busy, act } = useAct()
  const [tab, setTab] = useState<'preset' | 'custom'>('preset')
  const [pick, setPick] = useState<PresetRow | null>(null)
  const [key, setKey] = useState('')
  const [name, setName] = useState('')
  const [type, setType] = useState<'openai' | 'anthropic'>('openai')
  const [url, setUrl] = useState('')
  const [keyless, setKeyless] = useState(false)

  const submit = async (): Promise<void> => {
    const body = tab === 'preset' && pick ? { preset: pick.name, apiKey: key } : { custom: { name: name.trim().toLowerCase(), type, baseUrl: url.trim(), keyless }, apiKey: key }
    const added = tab === 'preset' && pick ? pick.name : name.trim().toLowerCase()
    const r = await act('add', () => api<ProvidersState>('POST', BASE, body), t('p_added'))
    if (!r) return
    onAdded(r, added)
    // Fetch the real model list right away: that is what the user wants next, and it proves the key.
    if (key || (tab === 'preset' ? pick?.keyless : keyless)) {
      const f = await act('fetch', () => api<ProvidersState>('POST', `${BASE}/${encodeURIComponent(added)}/refresh`, {}))
      if (f) onAdded(f, added)
    }
    onClose()
  }
  const needsKey = tab === 'preset' ? pick && !pick.keyless : !keyless
  const ready = tab === 'preset' ? !!pick : name.trim() && /^https?:\/\//i.test(url.trim())
  return (
    <Dialog title={t('p_add')} onClose={onClose} wide>
      <div className="preset-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'preset'} className={tab === 'preset' ? 'on' : ''} onClick={() => setTab('preset')}>
          {t('p_presets')}
        </button>
        <button role="tab" aria-selected={tab === 'custom'} className={tab === 'custom' ? 'on' : ''} onClick={() => setTab('custom')}>
          {t('p_custom')}
        </button>
      </div>
      {tab === 'preset' ? (
        <div className="preset-grid">
          {state.presets.map((p) => (
            <button key={p.name} className={`preset${pick?.name === p.name ? ' on' : ''}`} disabled={p.added} onClick={() => setPick(p)} aria-pressed={pick?.name === p.name}>
              <strong>{p.label}</strong>
              <span className="muted">{p.added ? t('p_addedAlready') : p.note}</span>
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="two">
            <Field label={t('p_name')} hint="my-llm">
              <input value={name} onChange={(e) => setName(e.target.value)} dir="ltr" maxLength={32} />
            </Field>
            <Field label={t('p_protocol')}>
              <select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
                <option value="openai">OpenAI-compatible</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </Field>
          </div>
          <Field label={t('p_baseUrl')}>
            <input value={url} onChange={(e) => setUrl(e.target.value)} dir="ltr" placeholder="https://api.example.com/v1" />
          </Field>
          <Switch checked={keyless} onChange={setKeyless} label={t('p_keyless')} />
        </>
      )}
      {needsKey ? (
        <Field label={t('p_keyLabel')} hint={t('p_keyHint')}>
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} dir="ltr" placeholder={t('p_keyPlaceholder')} />
        </Field>
      ) : null}
      <div className="dialog-foot">
        <Button kind="ghost" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button kind="primary" onClick={() => void submit()} disabled={!ready || !!busy}>
          {busy ? t('working') : t('p_add')}
        </Button>
      </div>
    </Dialog>
  )
}

function ModelLine({ m, busy, onUse, onTest, onThink, onContext, onRemove }: { m: ModelRow; busy: boolean; onUse: () => void; onTest: () => void; onThink: (l: ThinkLevel) => void; onContext: () => void; onRemove: () => void }) {
  const t = useT()
  const statusText = m.status === 'ok' ? t('p_works') : m.status === 'fail' ? t('p_failed') : t('p_untested')
  return (
    <li className={`model-row${m.active ? ' is-active' : ''}`}>
      <button className="dot-btn" onClick={onTest} disabled={busy} title={`${statusText}${m.checkedAt ? ` · ${relativeTime(m.checkedAt)}` : ''} — ${t('p_test')}`} aria-label={`${statusText}. ${t('p_test')}`}>
        <Dot status={m.status} title={statusText} />
      </button>
      <div className="model-id">
        <span className="mono" dir="ltr">{m.id}</span>
        {m.active ? <Badge tone="brand">{t('p_active')}</Badge> : null}
        {m.status === 'fail' && m.statusDetail ? <span className="model-err" dir="auto">{m.statusDetail}</span> : null}
      </div>
      <button className="ctx" onClick={onContext} title={t('p_editContext')}>
        <span className="ctx-n">{formatTokens(m.contextTokens)}</span>
        <span className="ctx-o">{t(`p_origin_${m.contextOrigin}` as 'p_origin_api')}</span>
      </button>
      {m.thinking ? (
        <select className="think-sel" value={m.thinking.level} onChange={(e) => onThink(e.target.value as ThinkLevel)} aria-label={t('p_thinking')} title={m.thinking.note}>
          {m.thinking.levels.map((l) => (
            <option key={l} value={l}>
              {t(`think_${l}` as 'think_off')}
            </option>
          ))}
        </select>
      ) : (
        <span className="muted think-none" title={t('p_noThinking')}>—</span>
      )}
      <div className="model-actions">
        {!m.active ? (
          <Button small kind="ghost" onClick={onUse} disabled={busy}>
            {t('p_use')}
          </Button>
        ) : null}
        <button className="icon-btn" onClick={onRemove} disabled={busy || m.active} aria-label={t('remove')} title={m.active ? t('p_inUse') : t('remove')}>
          <Icon name="trash" size={15} />
        </button>
      </div>
    </li>
  )
}

function ProviderDetail({ p, onState, onRemoved }: { p: ProviderRow; onState: (s: ProvidersState) => void; onRemoved: () => void }) {
  const t = useT()
  const { busy, act } = useAct()
  const toast = useToast()
  const [key, setKey] = useState('')
  const [newModel, setNewModel] = useState('')
  const [ctx, setCtx] = useState<ModelRow | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [filter, setFilter] = useState('')
  const shownModels = p.models.filter((m) => m.id.toLowerCase().includes(filter.trim().toLowerCase()))
  const url = `${BASE}/${encodeURIComponent(p.name)}`
  const post = <T,>(label: string, path: string, body: unknown, ok?: string) =>
    act(label, async () => {
      const r = await api<T>('POST', `${url}${path}`, body)
      onState(r as unknown as ProvidersState)
      return r
    }, ok)

  const refresh = async (): Promise<void> => {
    const r = await act('fetch', () => api<ProvidersState>('POST', `${url}/refresh`, {}))
    if (r) (onState(r), toast(t('p_fetched', { n: r.found ?? 0 })))
  }

  return (
    <section className="prov-detail" aria-label={p.label}>
      <header className="prov-head">
        <div>
          <h2>{p.label}</h2>
          <div className="muted mono" dir="ltr">{p.baseUrl}</div>
        </div>
        <div className="prov-badges">
          <KeyChip p={p} />
          {p.active ? <Badge tone="brand">{t('p_default')}</Badge> : null}
        </div>
      </header>

      {!p.keyless ? (
        <form
          className="key-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (!key.trim()) return
            void act('key', () => api<ProvidersState>('PUT', `${url}/key`, { apiKey: key.trim() }), t('p_keySaved')).then((r) => {
              if (r) (onState(r), setKey(''))
            })
          }}
        >
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} dir="ltr" placeholder={p.key === 'vault' || p.key === 'env' ? t('p_replaceKey') : t('p_keyPlaceholder')} aria-label={t('p_keyLabel')} />
          <Button type="submit" kind="primary" disabled={!key.trim() || !!busy}>
            {t('p_saveKey')}
          </Button>
          {p.key === 'vault' ? (
            <Button kind="ghost" onClick={() => void act('rmkey', () => api<ProvidersState>('DELETE', `${url}/key`), t('p_keyRemoved')).then((r) => r && onState(r))} disabled={!!busy}>
              {t('p_removeKey')}
            </Button>
          ) : null}
        </form>
      ) : null}

      <div className="prov-actions">
        <Button icon="down" onClick={() => void refresh()} disabled={!!busy}>
          {busy === 'fetch' ? t('working') : t('p_fetch')}
        </Button>
        <Button icon="check" onClick={() => void post('test', '/test', {})} disabled={!!busy || !p.models.length}>
          {busy === 'test' ? t('p_testing') : t('p_testAll')}
        </Button>
        {!p.active ? (
          <Button kind="primary" onClick={() => void act('activate', () => api<ProvidersState>('POST', `${BASE}/activate`, { name: p.name }), t('p_nowDefault', { model: p.label })).then((r) => r && onState(r))} disabled={!!busy || !p.models.length}>
            {t('p_makeDefault')}
          </Button>
        ) : null}
        <span className="spacer" />
        {!p.active ? (
          confirm ? (
            <>
              <span className="muted">{t('p_confirmRemove')}</span>
              <Button kind="danger" small onClick={() => void act('rm', () => api<ProvidersState>('DELETE', url)).then((r) => r && (onState(r), onRemoved()))}>
                {t('remove')}
              </Button>
              <Button kind="ghost" small onClick={() => setConfirm(false)}>
                {t('cancel')}
              </Button>
            </>
          ) : (
            <Button kind="ghost" icon="trash" onClick={() => setConfirm(true)}>
              {t('p_removeProvider')}
            </Button>
          )
        ) : null}
      </div>

      <h3 className="sec">{t('p_models')}</h3>
      {p.models.length > 6 ? (
        <input type="search" className="model-filter" value={filter} onChange={(e) => setFilter(e.target.value)} dir="ltr" placeholder={t('p_filter')} aria-label={t('p_filter')} />
      ) : null}
      {p.models.length ? (
        <>
          <div className="model-head" aria-hidden="true">
            <span />
            <span>{t('model')}</span>
            <span>{t('p_context')}</span>
            <span>{t('p_thinking')}</span>
            <span />
          </div>
          <ul className="model-list">
            {shownModels.map((m) => (
              <ModelLine
                key={m.id}
                m={m}
                busy={!!busy}
                onTest={() => void post('test', '/test', { model: m.id })}
                onUse={() => void act('activate', () => api<ProvidersState>('POST', `${BASE}/activate`, { name: p.name, model: m.id }), t('p_nowDefault', { model: m.id })).then((r) => r && onState(r))}
                onThink={(level) => void post('think', '/model', { action: 'thinking', id: m.id, level }, t('saved'))}
                onContext={() => setCtx(m)}
                onRemove={() => void post('rmmodel', '/model', { action: 'remove', id: m.id })}
              />
            ))}
          </ul>
          {shownModels.length === 0 ? <p className="muted pad">{t('sb_noMatch', { q: filter })}</p> : null}
        </>
      ) : (
        <p className="muted pad">{t('p_noModels')}</p>
      )}
      <form
        className="row add-model"
        onSubmit={(e) => {
          e.preventDefault()
          const id = newModel.trim()
          if (!id) return
          void post('addmodel', '/model', { action: 'add', id }).then((r) => r && setNewModel(''))
        }}
      >
        <input value={newModel} onChange={(e) => setNewModel(e.target.value)} dir="ltr" placeholder={t('p_addModel')} aria-label={t('p_addModel')} />
        <Button type="submit" icon="plus" disabled={!newModel.trim() || !!busy}>
          {t('add')}
        </Button>
      </form>
      {ctx ? <ContextDialog provider={p.name} model={ctx} onClose={() => setCtx(null)} onSaved={onState} /> : null}
    </section>
  )
}

/** Settings → Models & providers. */
export function Providers({ state, reload, set }: { state: ProvidersState | null; reload: () => void; set: (s: ProvidersState) => void }) {
  const t = useT()
  const [sel, setSel] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  useEffect(() => {
    if (state && (!sel || !state.providers.some((p) => p.name === sel))) setSel(state.active.name)
  }, [state, sel])
  if (!state) return <p className="muted pad">{t('loading')}</p>
  const current = state.providers.find((p) => p.name === sel) ?? state.providers[0]
  return (
    <div className="providers">
      <p className="lede">{t('p_sub')}</p>
      <div className="prov-layout">
        <nav className="prov-list" aria-label={t('p_title')}>
          <ul>
            {state.providers.map((p) => (
              <li key={p.name}>
                <button className={`prov-item${p.name === current?.name ? ' on' : ''}`} onClick={() => setSel(p.name)} aria-current={p.name === current?.name ? 'true' : undefined}>
                  <span className={`dot dot-${p.key === 'none' ? 'fail' : p.models.some((m) => m.status === 'ok') ? 'ok' : 'unknown'}`} aria-hidden="true" />
                  <span className="prov-name">{p.label}</span>
                  {p.active ? <span className="prov-def">{t('p_default')}</span> : null}
                </button>
              </li>
            ))}
          </ul>
          <Button icon="plus" onClick={() => setAdding(true)}>
            {t('p_add')}
          </Button>
        </nav>
        {current ? <ProviderDetail key={current.name} p={current} onState={set} onRemoved={() => (setSel(null), reload())} /> : null}
      </div>
      {adding ? <AddProviderDialog state={state} onClose={() => setAdding(false)} onAdded={(s, name) => (set(s), setSel(name))} /> : null}
    </div>
  )
}
