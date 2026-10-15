import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { useRegisterCommands, type Cmd } from '../commands'
import { useLiveSession, useResource, useStickToBottom } from '../hooks'
import { useT } from '../i18n'
import { usePrefs } from '../prefs'
import type { Insights, Me, ModelsInfo, ProvidersState, SessionView, SkillRow, ThinkLevel } from '../types'
import { Approvals } from './Approvals'
import { Chat } from './Chat'
import { Composer } from './Composer'
import { Panel, type PanelTab } from './Panel'
import type { Route } from './Sidebar'
import { downloadText, useToast } from './toast'
import { Badge, Icon, Menu, MenuItem, StateBadge } from './ui'

/** One session: header, conversation, composer and the details panel. */
export function SessionPage({ id, me, models, onChanged, onToggleSidebar, go }: { id: string; me: Me; models: ModelsInfo | null; onChanged: () => void; onToggleSidebar: () => void; go: (r: Route) => void }) {
  const t = useT()
  const toast = useToast()
  const { prefs } = usePrefs()
  const live = useLiveSession(id)
  const [panelOpen, setPanelOpen] = useState(() => prefs.panel && (typeof window !== 'undefined' ? window.innerWidth > 1180 : true))
  const [tab, setTab] = useState<PanelTab>('proof')
  const [error, setError] = useState<string | null>(null)
  const [insights, setInsights] = useState<Insights | null>(null)
  const { view } = live
  const scroll = useStickToBottom<HTMLDivElement>(`${view?.transcript.length}:${live.stream.length}:${view?.state}`)
  const isOwner = me.role === 'owner'

  // Owner-only data for the composer: thinking levels of the model in use, and the skills on offer.
  const providers = useResource<ProvidersState>(isOwner ? '/api/manage/providers' : null)
  const skills = useResource<SkillRow[]>(isOwner ? '/api/manage/skills' : null)

  // The proof and cost panel follows the session: refetched (debounced) when something changed.
  const stamp = `${view?.state}:${view?.updatedAt}:${view?.transcript.length}`
  useEffect(() => {
    if (!view || !panelOpen) return
    let alive = true
    const timer = setTimeout(() => {
      api<Insights>('GET', `/api/sessions/${encodeURIComponent(id)}/insights`)
        .then((r) => alive && setInsights(r))
        .catch(() => {})
    }, 350)
    return () => {
      alive = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, panelOpen, stamp])

  useEffect(() => {
    const on = (): void => setPanelOpen((o) => !o)
    window.addEventListener('vara:panel', on)
    return () => window.removeEventListener('vara:panel', on)
  }, [])

  const run = async (fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    setError(null)
    try {
      await fn()
      live.reload()
      onChanged()
      if (ok) toast(ok)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const post = (path: string, body: unknown = {}): Promise<unknown> => api('POST', `/api/sessions/${encodeURIComponent(id)}${path}`, body)
  const busy = view?.state === 'running'
  const modelList = models ? (models.allowed === 'any' ? [] : models.allowed) : []

  const activeProv = providers.data?.providers.find((p) => p.name === providers.data?.active.name)
  const thinkRow = activeProv?.models.find((m) => m.id === (view?.model ?? providers.data?.active.model))
  const setThink = (level: ThinkLevel): void => {
    if (!activeProv || !thinkRow) return
    void run(async () => providers.set(await api<ProvidersState>('POST', `/api/manage/providers/${encodeURIComponent(activeProv.name)}/model`, { action: 'thinking', id: thinkRow.id, level })), t('saved'))
  }

  const exportMd = async (): Promise<void> => {
    try {
      const r = await api<{ filename: string; markdown: string }>('GET', `/api/sessions/${encodeURIComponent(id)}/export`)
      downloadText(r.filename, r.markdown)
    } catch (e) {
      toast((e as Error).message, 'err')
    }
  }
  const sendText = (text: string, attachments: string[] = []): Promise<void> => run(() => post('/messages', { text, ...(attachments.length ? { attachments } : {}) }))
  const openPanel = (to: PanelTab): void => (setPanelOpen(true), setTab(to))

  // Everything the person may do here, as one list: slash commands, palette, menu.
  const cmds: Cmd[] = useMemo(() => {
    if (!view) return []
    const list: Cmd[] = []
    const add = (c: Cmd): void => void list.push(c)
    if (view.can.setMode)
      add({ id: 'mode', slash: 'mode', args: view.modeChoices.join('|'), options: view.modeChoices, group: 'session', title: t('cmd_mode'), description: t('cmd_modeHelp'), run: (a) => (view.modeChoices.includes(a) ? run(() => post('/mode', { mode: a }), t('saved')) : toast(t('cmd_usage', { u: `/mode ${view.modeChoices.join(' | ')}` }), 'err')) })
    if (view.can.manage)
      add({ id: 'kind', slash: 'kind', args: 'task|goal', options: ['task', 'goal'], group: 'session', title: t('cmd_kind'), description: t('cmd_kindHelp'), run: (a) => (a === 'task' || a === 'goal' ? run(() => post('/kind', { kind: a }), t('saved')) : toast(t('cmd_usage', { u: '/kind task | goal' }), 'err')) })
    if (view.can.setModel && modelList.length > 1)
      add({ id: 'model', slash: 'model', args: '<model>', options: modelList, group: 'session', title: t('cmd_model'), description: t('cmd_modelHelp'), run: (a) => (a ? run(() => post('/model', { model: a }), t('saved')) : toast(t('cmd_usage', { u: '/model <id>' }), 'err')) })
    if (view.can.manage && thinkRow?.thinking) {
      const levels = thinkRow.thinking.levels
      add({ id: 'think', slash: 'think', args: levels.join('|'), options: levels, group: 'session', title: t('cmd_think'), description: thinkRow.thinking.note, run: (a) => (levels.includes(a as ThinkLevel) ? setThink(a as ThinkLevel) : toast(t('cmd_usage', { u: `/think ${levels.join(' | ')}` }), 'err')) })
    }
    add({ id: 'cost', slash: 'cost', group: 'session', title: t('cmd_cost'), description: t('cmd_costHelp'), run: () => openPanel('cost') })
    add({ id: 'context', slash: 'context', group: 'session', title: t('cmd_context'), run: () => openPanel('cost') })
    add({ id: 'status', slash: 'status', group: 'session', title: t('cmd_status'), run: () => openPanel('proof') })
    add({ id: 'evidence', slash: 'evidence', group: 'session', title: t('cmd_evidence'), run: () => openPanel('proof') })
    if (isOwner) add({ id: 'preview', slash: 'preview', group: 'session', title: t('cmd_preview'), description: t('cmd_previewHelp'), run: () => openPanel('preview') })
    add({ id: 'export', slash: 'export', group: 'session', title: t('cmd_export'), description: t('cmd_exportHelp'), run: () => void exportMd() })
    if (view.can.pause) {
      if (busy) add({ id: 'pause', slash: 'pause', group: 'session', title: t('pause'), description: t('cmd_pauseHelp'), run: () => run(() => post('/pause')) })
      add({ id: 'stop', slash: 'stop', group: 'session', title: t('cmd_stop'), description: t('cmd_stopHelp'), run: () => run(() => post('/stop'), t('stopped')) })
    }
    if (view.can.manage) add({ id: 'share', slash: 'share', group: 'session', title: view.shared ? t('unshare') : t('share'), run: () => run(() => post('/share', { shared: !view.shared })) })
    if (view.can.manage && skills.data) {
      const on = skills.data.filter((s) => s.enabled)
      add({
        id: 'skill',
        slash: 'skill',
        args: '<name> [about]',
        options: on.map((s) => s.name),
        group: 'skill',
        title: t('cmd_skill'),
        description: t('cmd_skillHelp'),
        run: (a) => {
          const [name = '', ...rest] = a.split(/\s+/)
          const s = on.find((x) => x.name === name.toLowerCase())
          if (!s) return toast(t('cmd_noSkill', { n: name || '…' }), 'err')
          return sendText(`Use the "${s.name}" skill${rest.length ? `: ${rest.join(' ')}` : ' on the current work.'}`)
        },
      })
      for (const s of on) add({ id: `skill:${s.name}`, slash: s.name, args: '[about]', group: 'skill', title: t('cmd_useSkill', { n: s.name }), description: s.description, run: (a) => sendText(`Use the "${s.name}" skill${a ? `: ${a}` : ' on the current work.'}`) })
    }
    add({ id: 'new', slash: 'new', group: 'go', title: t('newSession'), shortcut: 'Ctrl Shift O', run: () => go({ page: 'home' }) })
    add({ id: 'help', slash: 'help', group: 'go', title: t('cmd_help'), run: () => go({ page: 'settings', tab: 'about' }) })
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, t, busy, skills.data, thinkRow, modelList.join('|'), id])
  useRegisterCommands('session', cmds)

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

  const finished = view.state === 'stopped'
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
            {view.intent === 'task' || view.intent === 'goal' ? <Badge tone="muted">{t(`kind_${view.kind === 'goal' ? 'goal' : 'task'}` as 'kind_goal')}</Badge> : null}
            <Badge tone={view.mode === 'plan' ? 'warn' : 'ok'}>{view.customMode ?? (view.mode === 'plan' ? t('mode_plan') : t('mode_build'))}</Badge>
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
        {view.can.manage ? (
          <button className={`share-btn${view.shared ? ' on' : ''}`} onClick={() => void run(() => post('/share', { shared: !view.shared }))} aria-pressed={view.shared}>
            <Icon name="users" size={15} /> {view.shared ? t('sharedBadge') : t('share')}
          </button>
        ) : null}
        <Menu label={t('more')}>
          {(close) => (
            <>
              <MenuItem icon="download" onClick={() => (close(), void exportMd())}>
                {t('cmd_export')}
              </MenuItem>
              {view.can.pause && busy ? (
                <MenuItem icon="pause" onClick={() => (close(), void run(() => post('/pause')))}>
                  {t('pause')}
                </MenuItem>
              ) : null}
              {view.can.manage && (view.kind === 'task' || view.kind === 'goal') ? (
                <MenuItem icon="goal" onClick={() => (close(), void run(() => post('/kind', { kind: view.kind === 'goal' ? 'task' : 'goal' }), t('saved')))}>
                  {view.kind === 'goal' ? t('menu_toTask') : t('menu_toGoal')}
                </MenuItem>
              ) : null}
              {view.can.pause && !finished ? (
                <MenuItem icon="stop" danger onClick={() => (close(), void run(() => post('/stop'), t('stopped')))}>
                  {t('cmd_stop')}
                </MenuItem>
              ) : null}
            </>
          )}
        </Menu>
        <button className="icon-btn" onClick={() => setPanelOpen((o) => !o)} aria-label={t('details')} title={`${t('details')} (Ctrl .)`} aria-pressed={panelOpen}>
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
          {isOwner ? <Approvals items={view.pendingApprovals} onAnswer={(aid, approved) => void run(() => post(`/approvals/${encodeURIComponent(aid)}`, { approved }))} /> : null}
          <div className="composer-wrap">
            <Composer
              key={id}
              draftKey={id}
              disabled={!view.can.send}
              busy={busy}
              canPause={view.can.pause}
              onPause={() => void run(() => post('/pause'))}
              placeholder={view.can.send ? undefined : t('placeholderReadOnly')}
              commands={cmds}
              files={isOwner}
              onUnknownCommand={(n) => toast(t('cmd_unknown', { n }), 'err')}
              onSend={sendText}
              controls={
                <>
                  {view.can.setMode ? (
                    <select value={view.customMode ?? view.mode} onChange={(e) => void run(() => post('/mode', { mode: e.target.value }))} aria-label={t('mode')}>
                      {view.modeChoices.map((m) => (
                        <option key={m} value={m}>
                          {m === 'plan' ? t('mode_plan') : m === 'build' ? t('mode_build') : m}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  {view.can.setModel && modelList.length > 1 ? (
                    <select value={view.model ?? ''} onChange={(e) => void run(() => post('/model', { model: e.target.value }))} aria-label={t('model')}>
                      {modelList.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  {view.can.manage && thinkRow?.thinking ? (
                    <select value={thinkRow.thinking.level} onChange={(e) => setThink(e.target.value as ThinkLevel)} aria-label={t('p_thinking')} title={thinkRow.thinking.note}>
                      {thinkRow.thinking.levels.map((l) => (
                        <option key={l} value={l}>
                          {t('p_thinking')}: {t(`think_${l}` as 'think_off')}
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
        {panelOpen ? <Panel view={view} insights={insights} tab={tab} onTab={setTab} owner={isOwner} /> : null}
      </div>
    </main>
  )
}
