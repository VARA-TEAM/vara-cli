import { useT, type Key } from '../i18n'
import { changedFiles, formatCost, formatTokens, relativeTime } from '../transcript'
import type { Insights, McpServerRow, SessionView, SkillRow } from '../types'
import { SessionTools } from './SessionTools'
import { Icon } from './ui'
import { Preview } from './Preview'

export type PanelTab = 'proof' | 'cost' | 'files' | 'preview' | 'tools'

function Gauge({ value, max, label, tone }: { value: number; max: number; label: string; tone?: 'warn' | 'err' }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, Math.round((value / max) * 100))) : 0
  const t = tone ?? (pct >= 90 ? 'err' : pct >= 70 ? 'warn' : undefined)
  return (
    <div className="gauge-row">
      <div className="gauge-label">
        <span>{label}</span>
        <span className="muted num">
          {formatTokens(value)} / {formatTokens(max)}
        </span>
      </div>
      <div className="gauge" role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label}>
        <i className={t ? `g-${t}` : ''} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function Proof({ view, insights }: { view: SessionView; insights: Insights | null }) {
  const t = useT()
  const verified = new Set(view.verified)
  const work = view.intent !== 'chat' && view.intent !== 'question'
  const b = insights?.budget
  return (
    <>
      {view.plan?.length ? (
        <section>
          <h3>{t('plan_title')}</h3>
          <ul className="reqs">
            {view.plan.map((p, i) => (
              <li key={i} className={p.status === 'done' ? 'done' : p.status === 'in_progress' ? 'doing' : ''}>
                <span className="req-mark">{p.status === 'done' ? <Icon name="check" size={13} /> : p.status === 'in_progress' ? <span className="pulse" /> : null}</span>
                <span dir="auto">{p.text}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {work ? (
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
      ) : null}

      {work && insights && insights.evidence.length ? (
        <section>
          <h3>
            {t('evidence')} <span className="count">{insights.budget.evidence}</span>
          </h3>
          <ol className="evidence">
            {[...insights.evidence].reverse().map((e, i) => (
              <li key={`${e.at}-${i}`} className={e.ok ? 'ok' : 'bad'}>
                <span className="ev-mark" aria-label={e.ok ? t('ok') : t('failed')}>
                  <Icon name={e.ok ? 'check' : 'x'} size={12} />
                </span>
                <div className="ev-main">
                  <div className="ev-title">
                    <span>{t(`ev_${e.kind}` as Key)}</span>
                    <span className="muted">{relativeTime(e.at)}</span>
                  </div>
                  {e.command ? (
                    <code className="ev-cmd" dir="ltr">
                      {e.command}
                      {e.exitCode !== undefined ? ` → ${e.exitCode}` : ''}
                    </code>
                  ) : null}
                  {e.files?.length ? <span className="muted ev-files" dir="ltr">{e.files.slice(0, 3).join(', ')}{e.files.length > 3 ? ` +${e.files.length - 3}` : ''}</span> : null}
                  {e.output ? (
                    <details>
                      <summary>{t('output')}</summary>
                      <pre dir="ltr">{e.output}</pre>
                    </details>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {b ? (
        <section>
          <h3>{t('limits')}</h3>
          <Gauge value={b.turns} max={b.maxTurns} label={t('a_turns')} />
          <Gauge value={b.modelCalls} max={b.maxModelCalls} label={t('calls')} />
        </section>
      ) : null}
    </>
  )
}

function Cost({ view, insights }: { view: SessionView; insights: Insights | null }) {
  const t = useT()
  const u = view.usage
  const cost = formatCost(u.costUsd, u.costPartial)
  const sv = insights?.savings
  const c = insights?.cost
  const money = (v: number | null): string => (v === null ? t('unknown') : `≈ $${v.toFixed(v < 0.01 ? 4 : 2)}`)
  const rows: Array<[string, string]> = []
  if (sv) {
    if (c?.cachedTokens) rows.push([t('sv_cache'), `${money(sv.cacheUsd)}${c.cacheHitPercent !== null ? ` · ${c.cacheHitPercent}%` : ''}`])
    if (sv.compactedTokens) rows.push([t('sv_compact'), `${formatTokens(sv.compactedTokens)} ${t('tokens')} · ${money(sv.compactUsd)}`])
    if (sv.dedupedReads) rows.push([t('sv_reads'), String(sv.dedupedReads)])
    if (sv.cheapCalls) rows.push([t('sv_cheap'), String(sv.cheapCalls)])
    if (sv.subagents) rows.push([t('sv_sub'), String(sv.subagents)])
  }
  return (
    <>
      <section>
        <div className="big-number" aria-label={t('cost')}>
          {cost ?? '—'}
        </div>
        {cost === null && u.modelCalls > 0 ? <p className="muted small">{t('costUnknownHelp')}</p> : null}
        <dl className="kv">
          <dt>{t('calls')}</dt>
          <dd>{u.modelCalls}</dd>
          <dt>{t('tools')}</dt>
          <dd>{u.toolCalls}</dd>
          <dt>{t('tokensIn')}</dt>
          <dd>{formatTokens(u.inputTokens)}</dd>
          {c?.cachedTokens ? (
            <>
              <dt>{t('tokensCached')}</dt>
              <dd>{formatTokens(c.cachedTokens)}</dd>
            </>
          ) : null}
          <dt>{t('tokensOut')}</dt>
          <dd>{formatTokens(u.outputTokens)}</dd>
        </dl>
      </section>

      <section>
        <h3>{t('sv_title')}</h3>
        {rows.length ? (
          <dl className="kv">
            {rows.map(([k, v]) => (
              <div key={k} className="kv-row">
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="muted small">{t('sv_none')}</p>
        )}
      </section>

      {insights ? (
        <section>
          <h3>{t('contextTitle')}</h3>
          <Gauge value={insights.context.usedTokens} max={insights.context.requestBudgetTokens} label={`~${insights.context.percent}%`} />
          <p className="muted small">
            {t('ctx_window', { n: formatTokens(insights.context.windowTokens) })} · {t(`ctx_src_${insights.context.source}` as Key)}
          </p>
        </section>
      ) : null}
    </>
  )
}

function Files({ view }: { view: SessionView }) {
  const t = useT()
  const files = changedFiles(view)
  return files.length ? (
    <section>
      <h3>
        {t('files')} <span className="count">{files.length}</span>
      </h3>
      <ul className="files" dir="ltr">
        {files.map((f) => (
          <li key={f.path}>
            <span className={`op op-${f.op}`}>{f.op === 'del' ? '−' : f.op === 'new' ? '+' : '~'}</span>
            <span className="path">{f.path}</span>
          </li>
        ))}
      </ul>
    </section>
  ) : (
    <p className="muted">{t('files_none')}</p>
  )
}

export function Panel({ view, insights, tab, onTab, owner, tools }: { view: SessionView; insights: Insights | null; tab: PanelTab; onTab: (t: PanelTab) => void; owner?: boolean; /** Owner only: per-session switches. */ tools?: { skills: SkillRow[]; servers: McpServerRow[]; onToggle: (kind: 'skill' | 'mcp', name: string, enabled: boolean) => void } }) {
  const t = useT()
  const files = changedFiles(view).length
  const tabs: Array<[PanelTab, Key]> = [
    ['proof', 'tab_proof'],
    ['cost', 'tab_cost'],
    ['files', 'tab_files'],
    ...(owner ? [['preview', 'tab_preview'] as [PanelTab, Key]] : []),
    ...(tools ? ([['tools', 'tab_tools']] as Array<[PanelTab, Key]>) : []),
  ]
  return (
    <aside className={`panel${tab === 'preview' ? ' panel-wide' : ''}`} aria-label={t('details')}>
      <div className="panel-tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => onTab(id)}>
            {t(label)}
            {id === 'files' && files ? <span className="count">{files}</span> : null}
          </button>
        ))}
      </div>
      <div className="panel-body" role="tabpanel">
        {tab === 'proof' ? <Proof view={view} insights={insights} /> : null}
        {tab === 'cost' ? <Cost view={view} insights={insights} /> : null}
        {tab === 'files' ? <Files view={view} /> : null}
        {tab === 'preview' && owner ? <Preview sessionId={view.id} /> : null}
        {tab === 'tools' && tools ? <SessionTools view={view} skills={tools.skills} servers={tools.servers} onToggle={tools.onToggle} /> : null}
      </div>
    </aside>
  )
}
