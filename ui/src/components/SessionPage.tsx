import { useState } from 'react'
import { api } from '../api'
import { useLiveSession, useStickToBottom } from '../hooks'
import { useT } from '../i18n'
import { changedFiles, formatCost, formatTokens } from '../transcript'
import type { Me, ModelsInfo, SessionView } from '../types'
import { Chat } from './Chat'
import { Composer } from './Composer'
import { Badge, Button, Icon, StateBadge, Switch } from './ui'

function Panel({ view, isOwner, onShare }: { view: SessionView; isOwner: boolean; onShare: (v: boolean) => void }) {
  const t = useT()
  const files = changedFiles(view)
  const verified = new Set(view.verified)
  const cost = formatCost(view.usage.costUsd, view.usage.costPartial)
  return (
    <aside className="panel" aria-label="details">
      {isOwner ? (
        <section>
          <Switch checked={view.shared} onChange={onShare} label={view.shared ? t('unshare') : t('share')} />
        </section>
      ) : null}
      {view.intent === 'chat' || view.intent === 'question' ? null : (
      <section>
        <h3>{t('requirements')}</h3>
        {view.requirements.length ? (
          <ul className="reqs">
            {view.requirements.map((r, i) => (
              <li key={i} className={verified.has(String(i + 1)) ? 'done' : ''}>
                <span className="req-mark">{verified.has(String(i + 1)) ? <Icon name="check" size={13} /> : null}</span>
                <span dir="auto">{r.replace(/^The stated objective is achieved and verified:\s*/, '').replace(/^\[follow-up \w+\]\s*/, '')}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t('empty')}</p>
        )}
      </section>
      )}
      {files.length ? (
        <section>
          <h3>
            {t('files')} <span className="count">{files.length}</span>
          </h3>
          <ul className="files" dir="ltr">
            {files.slice(-12).map((f) => (
              <li key={f.path}>
                <span className={`op op-${f.op}`}>{f.op === 'del' ? '−' : f.op === 'new' ? '+' : '~'}</span>
                <span className="path">{f.path}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section>
        <h3>{t('usage')}</h3>
        <dl className="kv">
          <dt>{t('calls')}</dt>
          <dd>{view.usage.modelCalls}</dd>
          <dt>{t('tools')}</dt>
          <dd>{view.usage.toolCalls}</dd>
          <dt>{t('tokens')}</dt>
          <dd>
            {formatTokens(view.usage.inputTokens)} → {formatTokens(view.usage.outputTokens)}
          </dd>
          <dt>{t('cost')}</dt>
          <dd>{cost ?? t('unknown')}</dd>
        </dl>
      </section>
    </aside>
  )
}

/** One session: header, conversation, composer and the details panel. */
export function SessionPage({ id, me, models, onChanged, onToggleSidebar }: { id: string; me: Me; models: ModelsInfo | null; onChanged: () => void; onToggleSidebar: () => void }) {
  const t = useT()
  const live = useLiveSession(id)
  const [panelOpen, setPanelOpen] = useState(() => (typeof window !== 'undefined' ? window.innerWidth > 1180 : true))
  const [error, setError] = useState<string | null>(null)
  const { view } = live
  const scroll = useStickToBottom<HTMLDivElement>(`${view?.transcript.length}:${live.stream.length}:${view?.state}`)
  const isOwner = me.role === 'owner'

  if (live.error && !view) {
    return (
      <main className="session">
        <div className="empty-state">
          <Icon name="alert" size={28} />
          <p>{live.error === 'revoked' ? t('error') : live.error}</p>
        </div>
      </main>
    )
  }
  if (!view) {
    return (
      <main className="session">
        <div className="empty-state muted">{t('loading')}</div>
      </main>
    )
  }

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null)
    try {
      await fn()
      live.reload()
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const busy = view.state === 'running'
  const modelList = models ? (models.allowed === 'any' ? [] : models.allowed) : []

  return (
    <main className="session">
      <header className="session-head">
        <button className="icon-btn only-narrow" onClick={onToggleSidebar} aria-label={t('sessions')}>
          <Icon name="menu" />
        </button>
        <div className="session-title">
          <h1 dir="auto" title={view.objective}>
            {view.objective}
          </h1>
          <div className="session-meta">
            <StateBadge state={view.state} />
            {view.intent ? <Badge tone="accent">{t(`intent_${view.intent}` as 'intent_chat')}</Badge> : null}
            <Badge tone={view.mode === 'plan' ? 'warn' : 'ok'}>{view.mode === 'plan' ? t('mode_plan') : t('mode_build')}</Badge>
            {view.model ? <span className="muted mono">{view.model}</span> : null}
            {view.shared ? (
              <Badge tone="user" title={t('share')}>
                <Icon name="users" size={12} /> {t('sharedBadge')}
              </Badge>
            ) : null}
            {view.participant ? <Badge tone="brand">{view.participant.name}</Badge> : null}
            {!live.connected ? <span className="muted">{t('connecting')}</span> : null}
          </div>
        </div>
        <button className="icon-btn" onClick={() => setPanelOpen((o) => !o)} aria-label="details" aria-pressed={panelOpen}>
          <Icon name="panel" />
        </button>
      </header>

      <div className="session-body">
        <div className="session-main">
          <div className="scroller" ref={scroll.ref}>
            <Chat view={view} stream={live.stream} thinking={live.thinking} activeTool={live.activeTool} subagents={live.subagents} isOwner={isOwner} />
          </div>
          {!scroll.atBottom ? (
            <button className="jump" onClick={scroll.jump}>
              <Icon name="down" size={15} /> {t('newMessages')}
            </button>
          ) : null}
          {error ? <div className="inline-error" role="alert">{error}</div> : null}
          <div className="composer-wrap">
            <Composer
              disabled={!view.can.send}
              busy={busy}
              canPause={view.can.pause}
              onPause={() => void run(() => api('POST', `/api/sessions/${view.id}/pause`, {}))}
              placeholder={view.can.send ? undefined : t('placeholderReadOnly')}
              onSend={(text) => run(() => api('POST', `/api/sessions/${view.id}/messages`, { text }))}
              controls={
                <>
                  {view.can.setMode ? (
                    <select value={view.mode} onChange={(e) => void run(() => api('POST', `/api/sessions/${view.id}/mode`, { mode: e.target.value }))} aria-label={t('mode')}>
                      <option value="plan">{t('mode_plan')}</option>
                      <option value="build">{t('mode_build')}</option>
                    </select>
                  ) : null}
                  {view.can.setModel && modelList.length > 1 ? (
                    <select value={view.model ?? ''} onChange={(e) => void run(() => api('POST', `/api/sessions/${view.id}/model`, { model: e.target.value }))} aria-label={t('model')}>
                      {modelList.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  {!view.can.send ? (
                    <span className="muted watching">
                      <Icon name="eye" size={15} /> {t('watching')}
                    </span>
                  ) : null}
                </>
              }
            />
          </div>
        </div>
        {panelOpen ? <Panel view={view} isOwner={isOwner} onShare={(v) => void run(() => api('POST', `/api/sessions/${view.id}/share`, { shared: v }))} /> : null}
      </div>
    </main>
  )
}
