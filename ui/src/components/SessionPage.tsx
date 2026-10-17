import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api'
import { useRegisterCommands, type Cmd } from '../commands'
import { useLiveSession, useResource, useStickToBottom } from '../hooks'
import { useT } from '../i18n'
import { mergeRuns, summarizeSwarm, swarmFromTranscript } from '../swarm-model'
import { buildItems } from '../transcript'
import type { Insights, McpState, Me, ModelsInfo, ProvidersState, SessionView, SettingsState, SkillRow, ThinkLevel } from '../types'
import { Approvals } from './Approvals'
import { Chat } from './Chat'
import { Composer } from './Composer'
import { Dock } from './Dock'
import { Panel } from './Panel'
import type { Route } from './Sidebar'
import { downloadText, useToast } from './toast'
import { Badge, Button, Icon, Menu, MenuItem, StateBadge } from './ui'
import { useWorkbench } from './Workbench'

/** One session: header, conversation and composer. Its side panel and dock render into the workbench slots while it is focused. */
export function SessionPage({ id, role, me, models, onChanged, onToggleSidebar, go }: { id: string; role: 'main' | 'split'; me: Me; models: ModelsInfo | null; onChanged: () => void; onToggleSidebar: () => void; go: (r: Route) => void }) {
  const t = useT()
  const toast = useToast()
  const wb = useWorkbench()
  const live = useLiveSession(id)
  const [error, setError] = useState<string | null>(null)
  const [insights, setInsights] = useState<Insights | null>(null)
  const [focusLast, setFocusLast] = useState(0)
  const { view } = live
  const scroll = useStickToBottom<HTMLDivElement>(`${view?.transcript.length}:${live.stream.length}:${view?.state}`)
  const isOwner = me.role === 'owner'
  const focused = !wb || wb.focused === id
  const sideTab = wb?.layout.sideTab ?? 'proof'
  const dockTab = wb?.layout.dockTab ?? 'output'

  // Owner-only data for the composer: thinking levels of the model in use, and the skills on offer.
  const providers = useResource<ProvidersState>(isOwner ? '/api/manage/providers' : null)
  const skills = useResource<SkillRow[]>(isOwner ? '/api/manage/skills' : null)
  const mcp = useResource<McpState>(isOwner ? '/api/manage/mcp' : null)
  const settings = useResource<SettingsState>(isOwner ? '/api/manage/settings' : null)

  // Sub-agent runs: what the saved transcript knows, plus what happened live on this page.
  const runs = useMemo(() => (view ? mergeRuns(swarmFromTranscript(buildItems(view)), live.swarm) : live.swarm), [view, live.swarm])
  const sum = summarizeSwarm(runs)

  // The proof and cost panel follows the session: refetched (debounced) when something changed.
  const needInsights = focused && !!wb?.sideOpen && (sideTab === 'proof' || sideTab === 'cost')
  const stamp = `${view?.state}:${view?.updatedAt}:${view?.transcript.length}`
  useEffect(() => {
    if (!view || !needInsights) return
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
  }, [id, needInsights, stamp])

  // Tell the status bar about this session.
  const setInfo = useRef(wb?.setInfo)
  setInfo.current = wb?.setInfo
  const costUsd = view?.usage.costUsd ?? null
  useEffect(() => {
    if (!view) return
    setInfo.current?.(id, { title: view.objective, state: view.state, ...(view.model ? { model: view.model } : {}), costUsd, costPartial: view.usage.costPartial, modelCalls: view.usage.modelCalls, agentsRunning: sum.running, agentsTotal: sum.total, connected: live.connected })
  }, [id, view?.objective, view?.state, view?.model, costUsd, view?.usage.costPartial, view?.usage.modelCalls, sum.running, sum.total, live.connected]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => setInfo.current?.(id, null), [id])

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

  /** What `@` can point at besides files. */
  const mentionList = isOwner
    ? [
        ...(skills.data ?? []).filter((s) => s.enabled && !(view?.disabledSkills ?? []).includes(s.name)).map((s) => ({ name: s.name, detail: s.description || t('m_skill') })),
        ...(mcp.data?.servers ?? []).filter((m) => m.enabled).map((m) => ({ name: m.name, detail: t('m_mcp') })),
        { name: 'agents', detail: t('m_agents') },
        { name: 'web', detail: t('m_web') },
        { name: 'browser', detail: t('m_browser') },
      ]
    : undefined

  const cancelAgents = (taskId?: string): void => {
    void run(async () => {
      const r = (await post('/agents/cancel', taskId ? { id: taskId } : {})) as { cancelled?: boolean }
      toast(r.cancelled ? t('ag_cancelSent') : t('ag_nothingToCancel'), r.cancelled ? 'ok' : 'err')
    })
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
  const openPanel = (to: 'proof' | 'cost' | 'files' | 'agents' | 'tools'): void => wb?.openSide(to)
  const openDock = (to: 'output' | 'preview' | 'events'): void => wb?.openDock(to)

  // Everything the person may do here, as one list: slash commands, palette, menu. Only the focused pane offers them.
  const cmds: Cmd[] = useMemo(() => {
    if (!view || !focused) return []
    const list: Cmd[] = []
    const add = (c: Cmd): void => void list.push(c)
    if (view.can.setMode)
      add({ id: 'mode', slash: 'mode', args: view.modeChoices.join('|'), options: view.modeChoices, group: 'session', title: t('cmd_mode'), description: t('cmd_modeHelp'), shortcut: 'Alt M', run: (a) => (view.modeChoices.includes(a) ? run(() => post('/mode', { mode: a }), t('saved')) : toast(t('cmd_usage', { u: `/mode ${view.modeChoices.join(' | ')}` }), 'err')) })
    if (view.can.manage)
      add({ id: 'kind', slash: 'kind', args: 'task|goal', options: ['task', 'goal'], group: 'session', title: t('cmd_kind'), description: t('cmd_kindHelp'), run: (a) => (a === 'task' || a === 'goal' ? run(() => post('/kind', { kind: a }), t('saved')) : toast(t('cmd_usage', { u: '/kind task | goal' }), 'err')) })
    if (view.can.setModel && modelList.length > 1)
      add({ id: 'model', slash: 'model', args: '<model>', options: modelList, group: 'session', title: t('cmd_model'), description: t('cmd_modelHelp'), run: (a) => (a ? run(() => post('/model', { model: a }), t('saved')) : toast(t('cmd_usage', { u: '/model <id>' }), 'err')) })
    if (view.can.manage && thinkRow?.thinking) {
      const levels = thinkRow.thinking.levels
      add({ id: 'think', slash: 'think', args: levels.join('|'), options: levels, group: 'session', title: t('cmd_think'), description: thinkRow.thinking.note, run: (a) => (levels.includes(a as ThinkLevel) ? setThink(a as ThinkLevel) : toast(t('cmd_usage', { u: `/think ${levels.join(' | ')}` }), 'err')) })
    }
    add({
      id: 'undo',
      slash: 'undo',
      args: '[n]',
      group: 'session',
      title: t('cmd_undo'),
      description: t('cmd_undoHelp'),
      run: (a) =>
        void run(async () => {
          const r = (await post('/undo', { count: Number(a) || 1 })) as { restored?: Array<{ path: string; what: string }>; failed?: Array<{ path: string; why: string }> }
          const done = (r.restored ?? []).map((x) => `${x.path}: ${x.what}`)
          const bad = (r.failed ?? []).map((x) => `${x.path}: ${x.why}`)
          toast(done.length || bad.length ? [...done, ...bad].join(' · ') : t('cmd_undoNothing'), bad.length || !done.length ? 'err' : 'ok')
        }),
    })
    add({
      id: 'compact',
      slash: 'compact',
      args: t('cmd_compactArgs'),
      group: 'session',
      title: t('cmd_compact'),
      description: t('cmd_compactHelp'),
      run: (a) =>
        void run(async () => {
          const r = (await post('/compact', a ? { focus: a } : {})) as { folded?: number; savedTokens?: number } | null
          toast(r ? t('cmd_compactDone', { n: String(r.folded ?? 0), tokens: (r.savedTokens ?? 0).toLocaleString() }) : t('cmd_compactNothing'), r ? 'ok' : 'err')
        }),
    })
    add({ id: 'cost', slash: 'cost', group: 'session', title: t('cmd_cost'), description: t('cmd_costHelp'), run: () => openPanel('cost') })
    add({ id: 'context', slash: 'context', group: 'session', title: t('cmd_context'), description: t('cmd_contextHelp'), run: () => openPanel('cost') })
    add({ id: 'status', slash: 'status', group: 'session', title: t('cmd_status'), description: t('cmd_statusHelp'), run: () => openPanel('proof') })
    add({ id: 'evidence', slash: 'evidence', group: 'session', title: t('cmd_evidence'), description: t('cmd_evidenceHelp'), run: () => openPanel('proof') })
    add({ id: 'last', slash: 'last', group: 'session', title: t('cmd_last'), description: t('cmd_lastHelp'), run: () => (openDock('output'), setFocusLast((n) => n + 1)) })
    if (isOwner)
      add({
        id: 'preview',
        slash: 'preview',
        args: '[start <command> | stop | logs]',
        options: ['start', 'stop', 'logs'],
        group: 'session',
        title: t('cmd_preview'),
        description: t('cmd_previewHelp'),
        run: (a) => {
          const [sub = '', ...rest] = a.trim().split(/\s+/)
          if (sub === 'start' && rest.length) return run(() => api('POST', `/api/sessions/${encodeURIComponent(id)}/preview`, { command: rest.join(' ') }).then(() => openDock('preview')))
          if (sub === 'stop') return run(() => api('DELETE', `/api/sessions/${encodeURIComponent(id)}/preview`), t('cmd_previewStopped'))
          openDock('preview')
        },
      })
    add({ id: 'export', slash: 'export', group: 'session', title: t('cmd_export'), description: t('cmd_exportHelp'), run: () => void exportMd() })
    if (view.can.pause) {
      if (busy) add({ id: 'pause', slash: 'pause', group: 'session', title: t('pause'), description: t('cmd_pauseHelp'), run: () => run(() => post('/pause')) })
      add({ id: 'stop', slash: 'stop', group: 'session', title: t('cmd_stop'), description: t('cmd_stopHelp'), run: () => run(() => post('/stop'), t('stopped')) })
    }
    if (view.can.manage && me.features?.team !== false) add({ id: 'share', slash: 'share', group: 'session', title: view.shared ? t('unshare') : t('share'), run: () => run(() => post('/share', { shared: !view.shared })) })
    if (view.can.send) add({ id: 'attach', slash: 'attach', group: 'session', title: t('cmd_attach'), description: t('cmd_attachHelp'), run: () => void window.dispatchEvent(new CustomEvent('vara:attach', { detail: { id } })) })
    if (isOwner && view.pendingApprovals.length) {
      const pick = (a: string): string | undefined => (a ? view.pendingApprovals.find((p) => p.id.startsWith(a))?.id : view.pendingApprovals[0]?.id)
      const answer = (approved: boolean) => (a: string): void | Promise<void> => {
        const aid = pick(a.trim())
        return aid ? run(() => post(`/approvals/${encodeURIComponent(aid)}`, { approved })) : toast(t('cmd_noApproval'), 'err')
      }
      add({ id: 'approve', slash: 'approve', args: '[id]', options: view.pendingApprovals.map((p) => p.id.slice(0, 8)), group: 'session', title: t('cmd_approve'), description: view.pendingApprovals[0]?.title, run: answer(true) })
      add({ id: 'deny', slash: 'deny', args: '[id]', options: view.pendingApprovals.map((p) => p.id.slice(0, 8)), group: 'session', title: t('cmd_deny'), description: view.pendingApprovals[0]?.title, run: answer(false) })
    }
    if (view.can.manage && skills.data) {
      const on = skills.data.filter((s) => s.enabled && !view.disabledSkills.includes(s.name))
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
    if (view.can.manage && (skills.data || mcp.data)) {
      // /enable and /disable: this session only, for a skill or an MCP server.
      const toggle = (enabled: boolean) => (a: string): void | Promise<void> => {
        const name = a.trim().toLowerCase()
        const sk = skills.data?.find((s) => s.name === name)
        const sv = mcp.data?.servers.find((s) => s.name.toLowerCase() === name)
        if (sk) return run(() => post('/toggle', { kind: 'skill', name: sk.name, enabled }), t('saved'))
        if (sv) return run(() => post('/toggle', { kind: 'mcp', name: sv.name, enabled }), t('saved'))
        return toast(t('cmd_noTool', { n: name || '…' }), 'err')
      }
      const names = [...(skills.data ?? []).map((s) => s.name), ...(mcp.data?.servers ?? []).map((s) => s.name)]
      add({ id: 'enable', slash: 'enable', args: '<skill|server>', options: names, group: 'session', title: t('cmd_enable'), description: t('cmd_enableHelp'), run: toggle(true) })
      add({ id: 'disable', slash: 'disable', args: '<skill|server>', options: names, group: 'session', title: t('cmd_disable'), description: t('cmd_disableHelp'), run: toggle(false) })
    }
    add({ id: 'new', slash: 'new', group: 'go', title: t('newSession'), shortcut: 'Ctrl Shift O', run: () => go({ page: 'home' }) })
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, t, busy, skills.data, mcp.data, thinkRow, modelList.join('|'), id, focused])
  useRegisterCommands(`session:${id}`, cmds)

  // Terminal keys that survive in the browser: Alt+M flips plan/build, Ctrl+G jumps to the latest message.
  useEffect(() => {
    if (!focused || !view) return
    const on = (e: KeyboardEvent): void => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'm' && view.can.setMode && view.modeChoices.includes('plan') && view.modeChoices.includes('build')) {
        e.preventDefault()
        void run(() => post('/mode', { mode: view.mode === 'plan' ? 'build' : 'plan' }), t('saved'))
      } else if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        scroll.jump()
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, view?.mode, view?.can.setMode, view?.modeChoices.join('|')])

  if (live.error && !view) {
    return (
      <main className="session" aria-label={t('sessions')}>
        <div className="empty-state">
          <Icon name="alert" size={28} />
          <h2>{live.error === 'revoked' ? t('error') : t('s_unavailable')}</h2>
          <p className="muted" dir="auto">{live.error === 'revoked' ? t('s_revoked') : live.error}</p>
          <div className="row">
            <Button onClick={() => go({ page: 'home' })} icon="plus">
              {t('newSession')}
            </Button>
            {wb ? (
              <Button kind="ghost" onClick={() => wb.closeTab(id)}>
                {t('wb_closeTab')}
              </Button>
            ) : null}
          </div>
        </div>
      </main>
    )
  }
  if (!view) {
    return (
      <main className="session" aria-busy="true">
        <div className="skeleton" aria-label={t('loading')}>
          <i />
          <i />
          <i />
        </div>
      </main>
    )
  }

  const finished = view.state === 'stopped'
  const sidePanel =
    wb && focused && wb.sideOpen && wb.sideSlot
      ? createPortal(
          <Panel
            view={view}
            insights={insights}
            tab={sideTab}
            onTab={(x) => wb.setSideTab(x)}
            onClose={() => wb.closeSide()}
            owner={isOwner}
            swarm={runs}
            swarmLimits={settings.data?.swarm ?? null}
            busy={!!busy}
            onPause={() => void run(() => post('/pause'))}
            onStop={() => void run(() => post('/stop'), t('stopped'))}
            onCancelAgents={cancelAgents}
            tools={isOwner && skills.data && mcp.data ? { skills: skills.data, servers: mcp.data.servers, onToggle: (kind, name, enabled) => void run(() => post('/toggle', { kind, name, enabled })) } : undefined}
          />,
          wb.sideSlot,
        )
      : null
  const dock =
    wb && focused && wb.dockOpen && wb.dockSlot
      ? createPortal(<Dock view={view} events={live.events} activeTool={live.activeTool} owner={isOwner} tab={dockTab} onTab={(x) => wb.setDockTab(x)} onClose={() => wb.closeDock()} focusLast={focusLast} />, wb.dockSlot)
      : null

  return (
    <main className="session" aria-label={view.objective}>
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
        <div className="session-actions">
        {sum.total > 0 ? (
          <button className={`agents-chip${sum.live ? ' live' : ''}`} onClick={() => wb?.openSide('agents', wb.sideOpen && sideTab === 'agents')} aria-pressed={!!wb?.sideOpen && sideTab === 'agents'} title={`${t('ag_open')} (Ctrl Shift A)`}>
            <Icon name="branch" size={14} />
            {sum.live ? <span className="pulse" aria-hidden="true" /> : null}
            <span className="num">{sum.live ? t('ag_status', { n: sum.running, total: sum.total }) : t('ag_chipDone', { n: sum.done, total: sum.total })}</span>
          </button>
        ) : null}
        {view.can.manage && me.features?.team !== false ? (
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
              <MenuItem icon="terminal" onClick={() => (close(), wb?.openDock('output', true))}>
                {t('wb_dock')}
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
        {role === 'split' && wb ? (
          <button className="icon-btn" onClick={() => wb.closeTab(id)} aria-label={t('wb_closeTab')} title={t('wb_closeTab')}>
            <Icon name="x" />
          </button>
        ) : (
          <button className="icon-btn" onClick={() => wb?.openSide(sideTab, true)} aria-label={t('details')} title={`${t('details')} (Ctrl .)`} aria-pressed={!!wb?.sideOpen}>
            <Icon name="panel" />
          </button>
        )}
        </div>
      </header>

      <div className="session-body">
        <div className="session-main">
          <div className="scroller" ref={scroll.ref} tabIndex={0} role="region" aria-label={t("s_conversation")}>
            <Chat view={view} stream={live.stream} thinking={live.thinking} activeTool={live.activeTool} swarm={runs} onOpenAgents={() => wb?.openSide('agents')} isOwner={isOwner} />
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
              mentions={mentionList}
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
      </div>
      {sidePanel}
      {dock}
    </main>
  )
}
