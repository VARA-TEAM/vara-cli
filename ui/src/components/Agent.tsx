import { useEffect, useState, type ReactNode } from 'react'
import { api } from '../api'
import { useT } from '../i18n'
import type { SettingsState } from '../types'
import { useAct } from './toast'
import { Switch } from './ui'

export function Row({ label, help, children }: { label: ReactNode; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="srow">
      <div className="srow-label">
        <strong>{label}</strong>
        {help ? <span className="muted">{help}</span> : null}
      </div>
      <div className="srow-control">{children}</div>
    </div>
  )
}

/** A number or text box that saves when you leave it (or press Enter) and says what is wrong in plain words. */
function Commit({ value, onCommit, kind = 'text', unit, list, placeholder }: { value: string; onCommit: (v: string) => Promise<boolean>; kind?: 'text' | 'number'; unit?: string; list?: string; placeholder?: string }) {
  const [v, setV] = useState(value)
  const [bad, setBad] = useState(false)
  useEffect(() => setV(value), [value])
  const go = async (): Promise<void> => {
    if (v === value) return
    const ok = await onCommit(v)
    setBad(!ok)
    if (!ok) setV(value)
  }
  return (
    <span className="commit">
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => void go()}
        onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget.blur(), undefined)}
        inputMode={kind === 'number' ? 'numeric' : undefined}
        dir={kind === 'number' ? 'ltr' : 'auto'}
        list={list}
        placeholder={placeholder}
        aria-invalid={bad || undefined}
        className={kind === 'number' ? 'num' : undefined}
      />
      {unit ? <span className="muted">{unit}</span> : null}
    </span>
  )
}

/** Settings → Agent: how VARA decides what to do, and the limits it works within. */
export function AgentPanel({ state, set, models }: { state: SettingsState | null; set: (s: SettingsState) => void; models: string[] }) {
  const t = useT()
  const { act } = useAct()
  if (!state) return <p className="muted pad">{t('loading')}</p>

  const patch = async (body: unknown, ok = true): Promise<boolean> => {
    const r = await act('save', () => api<SettingsState>('PATCH', '/api/manage/settings', body), ok ? t('saved') : undefined)
    if (r) set(r)
    return !!r
  }
  const num = (path: (n: number) => unknown) => async (v: string): Promise<boolean> => {
    const n = Number(v.trim())
    if (!Number.isInteger(n) || n < 1) return patch(path(NaN)) // the server answers with the exact message
    return patch(path(n))
  }
  const budget = (kind: 'task' | 'goal') => (
    <>
      <Row label={t('a_turns')} help={t(kind === 'task' ? 'a_turnsTask' : 'a_turnsGoal')}>
        <Commit kind="number" value={String(state.budgets[kind].maxTurns)} onCommit={num((n) => ({ budgets: { [kind]: { maxTurns: n } } }))} />
      </Row>
      <Row label={t('a_minutes')} help={t('a_minutesHelp')}>
        <Commit kind="number" unit={t('a_min')} value={String(state.budgets[kind].maxMinutes)} onCommit={num((n) => ({ budgets: { [kind]: { maxMinutes: n } } }))} />
      </Row>
      <Row label={t('a_calls')} help={t('a_callsHelp')}>
        <Commit kind="number" value={String(state.budgets[kind].maxModelCalls)} onCommit={num((n) => ({ budgets: { [kind]: { maxModelCalls: n } } }))} />
      </Row>
    </>
  )
  return (
    <div className="agent-panel">
      <datalist id="model-ids">
        {models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>

      <h3 className="sec">{t('a_behaviour')}</h3>
      <Row label={t('a_auto')} help={t('a_autoHelp')}>
        <Switch checked={state.agent.autoIntent} onChange={(v) => void patch({ agent: { autoIntent: v } })} label={state.agent.autoIntent ? t('on') : t('off')} />
      </Row>
      <Row label={t('a_mode')} help={t('a_modeHelp')}>
        <div className="seg" role="radiogroup" aria-label={t('a_mode')}>
          {(['plan', 'build'] as const).map((m) => (
            <button key={m} role="radio" aria-checked={state.agent.defaultMode === m} className={state.agent.defaultMode === m ? 'on' : ''} onClick={() => void patch({ agent: { defaultMode: m } })}>
              {t(m === 'plan' ? 'mode_plan' : 'mode_build')}
            </button>
          ))}
        </div>
      </Row>
      <Row label={t('a_verify')} help={t('a_verifyHelp')}>
        <Commit value={state.defaultVerifyCommand} placeholder="npm test" onCommit={(v) => patch({ defaultVerifyCommand: v })} />
      </Row>
      <Row label={t('a_cheap')} help={t('a_cheapHelp')}>
        <Commit value={state.agent.cheapModel} list="model-ids" placeholder={t('a_cheapNone')} onCommit={(v) => patch({ agent: { cheapModel: v } })} />
      </Row>
      <Row label={t('a_browser')} help={t('a_browserHelp')}>
        <Switch checked={state.agent.browser} onChange={(v) => void patch({ agent: { browser: v } })} label={state.agent.browser ? t('on') : t('off')} />
      </Row>
      <Row label={t('a_publish')} help={t('a_publishHelp')}>
        <Switch checked={state.allowPublish} onChange={(v) => void patch({ allowPublish: v })} label={state.allowPublish ? t('on') : t('off')} />
      </Row>

      <h3 className="sec">{t('sw_title')}</h3>
      <Row label={t('sw_tasks')} help={t('sw_tasksHelp')}>
        <Commit kind="number" value={String(state.swarm.maxTasks)} onCommit={num((n) => ({ swarm: { maxTasks: n } }))} />
      </Row>
      <Row label={t('sw_parallel')} help={t('sw_parallelHelp')}>
        <Commit kind="number" value={String(state.swarm.maxParallel)} onCommit={num((n) => ({ swarm: { maxParallel: n } }))} />
      </Row>
      <Row label={t('sw_calls')} help={t('sw_callsHelp')}>
        <Commit kind="number" value={String(state.swarm.maxModelCalls)} onCommit={num((n) => ({ swarm: { maxModelCalls: n } }))} />
      </Row>
      <Row label={t('sw_cost')} help={t('sw_costHelp')}>
        <Commit value={state.swarm.maxCostUsd === null ? '' : String(state.swarm.maxCostUsd)} placeholder={t('p_auto')} onCommit={(v) => patch({ swarm: { maxCostUsd: v.trim() ? Number(v.trim()) : null } })} />
      </Row>

      <Row label={t('a_updates')} help={t('a_updatesHelp')}>
        <Switch checked={state.updates.check} onChange={(v) => void patch({ updates: { check: v } })} label={state.updates.check ? t('on') : t('off')} />
      </Row>

      <h3 className="sec">{t('a_taskLimits')}</h3>
      {budget('task')}
      <h3 className="sec">{t('a_goalLimits')}</h3>
      {budget('goal')}

      <h3 className="sec">{t('a_contextTitle')}</h3>
      <Row label={t('a_window')} help={t('a_windowHelp')}>
        <Commit
          kind="number"
          value={state.context.windowTokens ? String(state.context.windowTokens) : ''}
          placeholder={t('p_auto')}
          unit={t('a_tokens')}
          onCommit={(v) => (v.trim() ? patch({ context: { windowTokens: Number(v.trim().replace(/[,_\s]/g, '')) } }) : patch({ context: { windowTokens: null } }))}
        />
      </Row>
      <Row label={t('a_reserve')} help={t('a_reserveHelp')}>
        <Commit kind="number" unit={t('a_tokens')} value={String(state.context.maxOutputTokens)} onCommit={(v) => patch({ context: { maxOutputTokens: Number(v.trim().replace(/[,_\s]/g, '')) } })} />
      </Row>
    </div>
  )
}
