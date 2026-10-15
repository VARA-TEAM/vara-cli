import { useEffect, useMemo, useState } from 'react'
import { useT, type Key } from '../i18n'
import { countStatus, elapsedMs, formatDuration, levels, runStatus, runTotals, traceLayout, type AgentRow, type AgentStatus, type SwarmRunModel } from '../swarm-model'
import { Markdown } from './Markdown'
import { Badge, Button, CopyButton, Icon } from './ui'

export interface SwarmLimitsView {
  maxTasks: number
  maxParallel: number
  maxModelCalls: number
  maxCostUsd: number | null
}

const STATUS_KEY: Record<AgentStatus, Key> = { waiting: 'sw_waiting', running: 'ag_running', done: 'ag_done', failed: 'ag_failed', skipped: 'sw_skipped' }

/** One tick per second while something is running, so elapsed times move. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

export function AgentStatusIcon({ status, size = 14 }: { status: AgentStatus; size?: number }) {
  if (status === 'running') return <span className="pulse" aria-hidden="true" />
  if (status === 'done') return <Icon name="check" size={size} />
  if (status === 'failed') return <Icon name="x" size={size} />
  if (status === 'skipped') return <span className="agent-skip" aria-hidden="true" />
  return <span className="agent-wait" aria-hidden="true" />
}

export function costText(run: SwarmRunModel, unknown: string): string | null {
  if (run.costUsd === undefined && run.costAtLeast === undefined) return null
  if (run.costUsd !== null && run.costUsd !== undefined) return `$${run.costUsd < 0.01 ? run.costUsd.toFixed(4) : run.costUsd.toFixed(2)}`
  return run.costAtLeast !== undefined ? `${unknown} (≥ $${run.costAtLeast.toFixed(4)})` : unknown
}

function Trace({ run, now, selected, onSelect }: { run: SwarmRunModel; now: number; selected: string | null; onSelect: (id: string) => void }) {
  const t = useT()
  const lanes = useMemo(() => traceLayout(run, now), [run, now])
  const ROW = 38
  const H = ROW * run.agents.length
  const byId = new Map(lanes.map((l, i) => [l.id, { l, i }]))
  const timed = lanes.some((l) => l.timed)
  const edges: string[] = []
  run.agents.forEach((a, i) => {
    for (const d of a.dependsOn) {
      const from = byId.get(d)
      if (!from) continue
      const x1 = from.l.x1 * 1000
      const x0 = lanes[i]!.x0 * 1000
      const y1 = from.i * ROW + ROW / 2
      const y0 = i * ROW + ROW / 2
      const xm = Math.max(x1, Math.min(x0, (x1 + x0) / 2))
      edges.push(`M${x1} ${y1} H${xm} V${y0} H${Math.max(xm, x0)}`)
    }
  })
  return (
    <div className="trace" role="group" aria-label={t('ag_trace')}>
      <div className="trace-labels">
        {run.agents.map((a) => (
          <button key={a.id} className={`trace-label${selected === a.id ? ' on' : ''}`} onClick={() => onSelect(a.id)} style={{ blockSize: ROW }} title={a.title}>
            <AgentStatusIcon status={a.status} size={13} />
            <span className="clip mono" dir="ltr">{a.id}</span>
          </button>
        ))}
      </div>
      <div className="trace-track" style={{ blockSize: H }}>
        <svg className="trace-edges" viewBox={`0 0 1000 ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {edges.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </svg>
        {run.agents.map((a, i) => {
          const l = lanes[i]!
          return (
            <div className="trace-lane" key={a.id} style={{ insetBlockStart: i * ROW, blockSize: ROW }}>
              <button
                className={`trace-bar st-${a.status}${l.timed ? '' : ' schematic'}${selected === a.id ? ' on' : ''}`}
                style={{ insetInlineStart: `${l.x0 * 100}%`, inlineSize: `${Math.max(1.5, (l.x1 - l.x0) * 100)}%` }}
                onClick={() => onSelect(a.id)}
                aria-label={`${a.id}: ${t(STATUS_KEY[a.status])}`}
                aria-pressed={selected === a.id}
              >
                {l.ticks.map((x, k) => (
                  <i key={k} style={{ insetInlineStart: `${Math.max(0, Math.min(100, ((x - l.x0) / Math.max(0.0001, l.x1 - l.x0)) * 100))}%` }} />
                ))}
                <span className="trace-bar-text clip" dir="auto">{a.role ?? a.title}</span>
              </button>
            </div>
          )
        })}
      </div>
      {!timed ? <p className="muted small trace-note">{t('ag_schematic')}</p> : null}
    </div>
  )
}

function AgentCard({ a, run, now, open, onToggle, onCancel }: { a: AgentRow; run: SwarmRunModel; now: number; open: boolean; onToggle: () => void; onCancel?: () => void }) {
  const t = useT()
  const ms = elapsedMs(a, now)
  const deps = a.dependsOn.length ? a.dependsOn.join(', ') : null
  return (
    <li className={`agent st-${a.status}${open ? ' open' : ''}`} id={`agent-${run.key}-${a.id}`}>
      <button className="agent-head" onClick={onToggle} aria-expanded={open}>
        <Icon name="chevron" size={13} className={`chev${open ? ' open' : ''}`} />
        <span className="agent-mark">
          <AgentStatusIcon status={a.status} />
        </span>
        <span className="agent-title clip" dir="auto">{a.title}</span>
        {a.role ? <span className="chip" dir="ltr">{a.role}</span> : null}
        <span className="muted small agent-st">{a.cancelled ? t('ag_cancelled') : t(STATUS_KEY[a.status])}</span>
      </button>
      <div className="agent-meta muted small">
        <span className="mono" dir="ltr">{a.id}</span>
        {deps ? <span dir="ltr">← {deps}</span> : null}
        {a.kind ? <span>{t(a.kind === 'work' ? 'ag_kind_work' : 'ag_kind_explore')}</span> : null}
        {a.steps ? <span className="num">{t('ag_steps', { n: a.steps })}</span> : null}
        {a.calls !== undefined ? <span className="num">{a.calls} {t('calls')}{a.costUsd === undefined ? '' : ` · ${a.costUsd === null ? t('unknown') : `$${a.costUsd < 0.01 ? a.costUsd.toFixed(4) : a.costUsd.toFixed(2)}`}`}</span> : null}
        {ms !== null ? <span className="num">{formatDuration(ms)}</span> : null}
        {a.detail && (a.status === 'running' || a.status === 'skipped') ? <span className="agent-now" dir="auto">{a.status === 'running' ? <><Icon name="terminal" size={12} /> {a.detail}</> : a.detail}</span> : null}
        {onCancel && a.status === 'running' ? (
          <button className="linklike agent-cancel" onClick={onCancel}>
            {t('ag_cancelOne')}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="agent-body">
          {a.report ? <Markdown text={a.report} /> : <p className="muted small">{a.status === 'running' || a.status === 'waiting' ? t('ag_noReportYet') : t('ag_noReport')}</p>}
        </div>
      ) : null}
    </li>
  )
}

/**
 * The Agents panel: every sub-agent run of the session, live. A run is a swarm of up to four agents with
 * roles and dependencies. The Trace shows who ran when and who waited for whom; the list shows each
 * agent's progress and its part of the report. Cost and model calls exist only for the whole swarm and
 * appear when it finishes: the engine does not report them per agent while it runs.
 */
export function AgentsPanel({
  runs,
  limits,
  canControl,
  busy,
  onPause,
  onStop,
  onCancel,
}: {
  runs: SwarmRunModel[]
  limits?: SwarmLimitsView | null
  canControl: boolean
  busy: boolean
  onPause: () => void
  onStop: () => void
  /** Cancel one agent by its task id, or every agent of the swarm; the session itself carries on. */
  onCancel: (id?: string) => void
}) {
  const t = useT()
  const [sel, setSel] = useState<string | null>(null)
  const [view, setView] = useState<'trace' | 'list'>('trace')
  const [openAgents, setOpenAgents] = useState<Record<string, boolean>>({})
  const [confirm, setConfirm] = useState(false)
  const latest = runs[runs.length - 1]
  const [runKey, setRunKey] = useState<string | null>(null)
  const run = runs.find((r) => r.key === runKey) ?? latest
  const anyLive = runs.some((r) => r.live)
  const now = useNow(anyLive)

  // A new run takes the view over unless the person picked an older one on purpose.
  useEffect(() => {
    if (latest && (!runKey || !runs.some((r) => r.key === runKey))) setRunKey(latest.key)
  }, [latest?.key, runs.length])
  useEffect(() => {
    if (!anyLive) setConfirm(false)
  }, [anyLive])

  if (!run) {
    return (
      <div className="agents-empty">
        <Icon name="branch" size={26} />
        <h3>{t('ag_emptyTitle')}</h3>
        <p className="muted">{t('ag_emptyBody')}</p>
        <code className="cmd" dir="auto">{t('ag_emptyExample')}</code>
        <CopyButton text={t('ag_emptyExample')} />
        {limits ? <p className="muted small">{t('ag_limits', { tasks: limits.maxTasks, par: limits.maxParallel, calls: limits.maxModelCalls })}</p> : null}
      </div>
    )
  }

  const c = countStatus(run)
  const st = runStatus(run)
  const done = c.done + c.failed + c.skipped
  const totals = runTotals(run)
  const cost = totals.any ? costText({ ...run, costUsd: totals.costUsd, ...(totals.costUsd === null && totals.atLeast > 0 ? { costAtLeast: totals.atLeast } : {}) }, t('unknown')) : null
  const dur = run.startedAt ? formatDuration(Math.max(0, (run.endedAt ?? (run.live ? now : run.startedAt)) - run.startedAt)) : null
  const toggleAgent = (id: string): void => setOpenAgents((o) => ({ ...o, [`${run.key}:${id}`]: !o[`${run.key}:${id}`] }))
  const select = (id: string): void => {
    setSel(id)
    setOpenAgents((o) => ({ ...o, [`${run.key}:${id}`]: true }))
    document.getElementById(`agent-${run.key}-${id}`)?.scrollIntoView({ block: 'nearest' })
  }
  const order = levels(run.agents).flat()
  const agents = view === 'list' ? order.map((id) => run.agents.find((a) => a.id === id)!).filter(Boolean) : run.agents

  return (
    <div className="agents">
      <section className="agents-sum">
        <div className="agents-line">
          <Badge tone={st === 'running' ? 'brand' : st === 'done' ? 'accent' : st === 'failed' || st === 'rejected' ? 'err' : st === 'partial' ? 'warn' : 'muted'}>
            {st === 'running' ? <span className="pulse" aria-hidden="true" /> : null}
            {t(`ag_run_${st}` as 'ag_run_done')}
          </Badge>
          <span className="num strong">{t('ag_progress', { done, total: run.agents.length })}</span>
          {runs.length > 1 ? (
            <select value={run.key} onChange={(e) => (setRunKey(e.target.value), setSel(null))} aria-label={t('ag_runs')} className="agents-runs">
              {runs.map((r, i) => (
                <option key={r.key} value={r.key}>
                  {t('ag_runN', { n: i + 1 })}{r.live ? ` · ${t('ag_live')}` : ''}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        <div className="agents-gauge" role="progressbar" aria-valuemin={0} aria-valuemax={run.agents.length} aria-valuenow={done} aria-label={t('ag_progress', { done, total: run.agents.length })}>
          {run.agents.map((a) => (
            <i key={a.id} className={`st-${a.status}`} />
          ))}
        </div>
        <dl className="kv agents-kv">
          {dur ? <><dt>{t('ag_time')}</dt><dd className="num">{dur}</dd></> : null}
          {totals.any ? <><dt>{t('calls')}</dt><dd className="num">{totals.calls}</dd></> : null}
          {cost ? <><dt>{t('cost')}</dt><dd className="num">{cost}</dd></> : null}
          {limits && run.live ? <><dt>{t('ag_parallel')}</dt><dd className="num">{t('ag_parOf', { n: c.running, max: limits.maxParallel })}</dd></> : null}
        </dl>
        {run.rejected ? <div className="inline-error" role="alert">{t('ag_rejected')}: {run.rejected}</div> : null}
        {run.live && run.modelCalls === undefined ? <p className="muted small">{t('ag_costLater')}</p> : null}
        {canControl && run.live ? (
          <div className="agents-actions">
            <Button small icon="x" onClick={() => onCancel()}>
              {t('ag_cancelAll')}
            </Button>
            <Button small kind="ghost" icon="pause" onClick={onPause} disabled={!busy}>
              {t('ag_pauseSession')}
            </Button>
            {confirm ? (
              <>
                <Button small kind="danger" icon="stop" onClick={() => (setConfirm(false), onStop())}>
                  {t('ag_stopConfirm')}
                </Button>
                <Button small kind="ghost" onClick={() => setConfirm(false)}>
                  {t('cancel')}
                </Button>
              </>
            ) : (
              <Button small kind="ghost" icon="stop" onClick={() => setConfirm(true)}>
                {t('ag_stopAll')}
              </Button>
            )}
          </div>
        ) : null}
        {canControl && run.live ? <p className="muted small">{t('ag_cancelNote')}</p> : null}
      </section>

      <section>
        <div className="agents-bar">
          <h3>{t('ag_agents')} <span className="count">{run.agents.length}</span></h3>
          <div className="seg seg-sm" role="group" aria-label={t('ag_view')}>
            <button className={view === 'trace' ? 'on' : ''} onClick={() => setView('trace')} aria-pressed={view === 'trace'}>
              <Icon name="trace" size={14} /> {t('ag_trace')}
            </button>
            <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')} aria-pressed={view === 'list'}>
              <Icon name="list" size={14} /> {t('ag_list')}
            </button>
          </div>
        </div>
        {view === 'trace' ? <Trace run={run} now={now} selected={sel} onSelect={select} /> : null}
        <ul className="agent-list">
          {agents.map((a) => (
            <AgentCard key={a.id} a={a} run={run} now={now} open={!!openAgents[`${run.key}:${a.id}`]} onToggle={() => toggleAgent(a.id)} {...(canControl && run.live ? { onCancel: () => onCancel(a.id) } : {})} />
          ))}
        </ul>
      </section>

      {run.merged && !run.rejected ? (
        <section>
          <details className="merged">
            <summary>
              {t('ag_merged')}
            </summary>
            <div className="merged-body">
              <CopyButton text={run.merged} />
              <pre dir="auto">{run.merged}</pre>
            </div>
          </details>
        </section>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {run.live ? t('ag_progress', { done, total: run.agents.length }) : ''}
      </span>
    </div>
  )
}
