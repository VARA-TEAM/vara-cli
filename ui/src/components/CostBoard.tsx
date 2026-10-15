import { useState, type ReactNode } from 'react'
import { api } from '../api'
import { MeterBody } from './CostMeter'
import { fmtTokens, fmtUsd, useCostBoard, useCostT, type CostBoardData, type CostSavings } from './CostShared'

/**
 * The owner's cost board: your limit and its pace, what VARA saved (with the
 * method stated), which model handles which turn, and the context switches.
 * Self-contained: render <CostBoard/> in any settings page or panel.
 */
export function CostBoard() {
  const t = useCostT()
  const { data, error, set } = useCostBoard(15_000)
  const [msg, setMsg] = useState('')

  if (error) return <p className="muted pad">{error}</p>
  if (!data) return <p className="muted pad">…</p>

  const patch = async (body: unknown): Promise<boolean> => {
    try {
      set(await api<CostBoardData>('PATCH', '/api/manage/cost', body))
      setMsg(t('saved'))
      setTimeout(() => setMsg(''), 2500)
      return true
    } catch (e) {
      setMsg((e as Error).message)
      return false
    }
  }

  return (
    <div style={{ display: 'grid', gap: 22, maxWidth: 760 }}>
      <Section title={t('title')}>
        <MeterBody st={data.status} compact={false} />
        <p className="muted" style={{ fontSize: 13 }} dir="auto">
          {data.status.message}
        </p>
        <LimitForm data={data} patch={patch} />
      </Section>

      <Section title={t('savings')}>
        <SavingsTable label={t('last24')} r={data.savings.day} />
        <SavingsTable label={t('last7')} r={data.savings.week} />
        <SavingsTable label={t('allTime')} r={data.savings.all} />
        <details>
          <summary className="muted" style={{ cursor: 'pointer' }}>
            {t('method')}
          </summary>
          <p className="muted" style={{ fontSize: 12, marginTop: 6 }} dir="ltr">
            {data.savings.all.method}
          </p>
        </details>
      </Section>

      <Section title={t('routing')}>
        <RoutingForm data={data} patch={patch} />
      </Section>

      <Section title={t('context')}>
        <Check checked={data.context.summarize} onChange={(v) => void patch({ context: { summarize: v } })} label={t('summarize')} />
        <Check checked={data.context.smartRead} onChange={(v) => void patch({ context: { smartRead: v } })} label={t('smartRead')} />
        <Field label={t('outChars')}>
          <NumberBox value={data.context.toolOutputChars} min={1000} max={12000} onCommit={(n) => patch({ context: { toolOutputChars: n } })} />
        </Field>
      </Section>
      <span role="status" aria-live="polite" className="muted" style={{ fontSize: 13, minHeight: 18 }} dir="auto">
        {msg}
      </span>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: 'grid', gap: 10, padding: 14, border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--surface)' }}>
      <h3 style={{ fontSize: 15 }}>{title}</h3>
      {children}
    </section>
  )
}

function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
      <span className="muted">{label}</span>
      {children}
    </label>
  )
}

function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span dir="auto">{label}</span>
    </label>
  )
}

/** A number box that saves on blur or Enter. */
function NumberBox({ value, min, max, onCommit }: { value: number; min: number; max: number; onCommit: (n: number) => Promise<boolean> }) {
  const [v, setV] = useState(String(value))
  const [last, setLast] = useState(value)
  if (value !== last) {
    setLast(value)
    setV(String(value))
  }
  const go = async (): Promise<void> => {
    const n = Number(v)
    if (!Number.isFinite(n) || n < min || n > max) return setV(String(value))
    if (n !== value && !(await onCommit(n))) setV(String(value))
  }
  return <input value={v} inputMode="decimal" dir="ltr" onChange={(e) => setV(e.target.value)} onBlur={() => void go()} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} style={inputStyle} />
}

const inputStyle = { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 10px', width: '100%' } as const
const rowStyle = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 } as const

function LimitForm({ data, patch }: { data: CostBoardData; patch: (b: unknown) => Promise<boolean> }) {
  const t = useCostT()
  const l = data.limits
  const [reading, setReading] = useState('')
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={rowStyle}>
        <Field label={t('unit')}>
          <select value={l.unit} onChange={(e) => void patch({ limits: { unit: e.target.value } })} style={inputStyle}>
            <option value="none">{t('none')}</option>
            <option value="tokens">{t('tokens')}</option>
            <option value="usd">{t('usd')}</option>
            <option value="percent">{t('percent')}</option>
          </select>
        </Field>
        {l.unit === 'tokens' || l.unit === 'usd' ? (
          <Field label={`${t('amount')} (${l.unit === 'usd' ? '$' : t('tokens')})`}>
            <NumberBox value={l.amount} min={0} max={1e12} onCommit={(n) => patch({ limits: { amount: n } })} />
          </Field>
        ) : null}
        {l.unit !== 'none' ? (
          <Field label={t('window')}>
            <select value={l.window.kind} onChange={(e) => void patch({ limits: { window: { kind: e.target.value } } })} style={inputStyle}>
              <option value="rolling">{t('rolling')}</option>
              <option value="day">{t('day')}</option>
              <option value="week">{t('week')}</option>
              <option value="month">{t('month')}</option>
            </select>
          </Field>
        ) : null}
        {l.unit !== 'none' && l.window.kind === 'rolling' ? (
          <Field label={t('hours')}>
            <NumberBox value={l.window.hours} min={0.25} max={744} onCommit={(n) => patch({ limits: { window: { hours: n } } })} />
          </Field>
        ) : null}
      </div>

      {l.unit === 'percent' ? (
        <div style={{ display: 'grid', gap: 6 }}>
          <span className="muted" style={{ fontSize: 13 }} dir="auto">
            {t('readingHelp')} ({l.readings.length})
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={reading} onChange={(e) => setReading(e.target.value)} placeholder={t('reading')} inputMode="decimal" dir="ltr" style={{ ...inputStyle, maxWidth: 200 }} />
            <button
              type="button"
              onClick={async () => {
                const n = Number(reading)
                if (Number.isFinite(n) && (await patch({ limits: { addReading: n } }))) setReading('')
              }}
            >
              {t('addReading')}
            </button>
          </div>
        </div>
      ) : null}

      {l.unit !== 'none' ? (
        <div style={{ display: 'grid', gap: 6 }}>
          <Check checked={l.autoEco} onChange={(v) => void patch({ limits: { autoEco: v } })} label={t('eco')} />
          <span className="muted" style={{ fontSize: 12 }} dir="auto">
            {t('ecoHelp')}
          </span>
          {l.autoEco ? (
            <Field label={t('ecoAt')}>
              <NumberBox value={l.ecoAt} min={1} max={100} onCommit={(n) => patch({ limits: { ecoAt: n } })} />
            </Field>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function SavingsTable({ label, r }: { label: string; r: CostSavings }) {
  const t = useCostT()
  const pct = (n: number | null) => (n === null ? t('unknown') : `${Math.abs(n) < 10 ? n.toFixed(1) : Math.round(n)}%`)
  if (r.calls === 0) return <p className="muted" style={{ fontSize: 13 }}>{label}: —</p>
  return (
    <div style={{ display: 'grid', gap: 2, fontSize: 13 }}>
      <strong>{label}</strong>
      <span dir="auto">
        {r.calls} {t('calls')} · {t('tokensSaved')}: <b>{r.tokensSavedPercent === null ? t('unknown') : r.tokensSavedPercent >= 0 ? pct(r.tokensSavedPercent) : `${pct(Math.abs(r.tokensSavedPercent))} ${t('moreThan')}`}</b> ({fmtTokens(r.actualTokens)} / {fmtTokens(r.baselineTokens)})
      </span>
      <span dir="auto">
        {t('usdSaved')}: <b>{pct(r.usdSavedPercent)}</b> ({fmtUsd(r.actualUsd) ?? t('unknown')} / {fmtUsd(r.baselineUsd) ?? t('unknown')})
      </span>
      {r.unknownCalls ? (
        <span className="muted" dir="auto">
          {r.unknownCalls} {t('unreported')}
        </span>
      ) : null}
    </div>
  )
}

function RoutingForm({ data, patch }: { data: CostBoardData; patch: (b: unknown) => Promise<boolean> }) {
  const t = useCostT()
  const r = data.routing
  const tier = (k: 'strong' | 'standard' | 'cheap', label: string) => (
    <TierRow key={k} label={label} value={r.tiers[k]} placeholder={k === 'cheap' && r.cheapModelLegacy ? r.cheapModelLegacy : t('default')} onSave={(v) => patch({ routing: { tiers: { [k]: v } } })} />
  )
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <Field label={t('floor')}>
        <select value={r.floor} onChange={(e) => void patch({ routing: { floor: e.target.value } })} style={inputStyle}>
          <option value="cheap">cheap</option>
          <option value="standard">standard</option>
          <option value="strong">strong</option>
        </select>
      </Field>
      {tier('strong', t('tierStrong'))}
      {tier('standard', t('tierStandard'))}
      {tier('cheap', t('tierCheap'))}
      <Check checked={r.escalateOnFailure} onChange={(v) => void patch({ routing: { escalateOnFailure: v } })} label={t('escalate')} />
    </div>
  )
}

function TierRow({ label, value, placeholder, onSave }: { label: string; value: { model: string; provider?: string } | null; placeholder: string; onSave: (v: { model: string; provider?: string } | null) => Promise<boolean> }) {
  const t = useCostT()
  const [model, setModel] = useState(value?.model ?? '')
  const [provider, setProvider] = useState(value?.provider ?? '')
  const commit = (): void => {
    const m = model.trim()
    if (m === (value?.model ?? '') && provider.trim() === (value?.provider ?? '')) return
    void onSave(m ? { model: m, ...(provider.trim() ? { provider: provider.trim() } : {}) } : null)
  }
  return (
    <Field label={label}>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8 }}>
        <input value={model} onChange={(e) => setModel(e.target.value)} onBlur={commit} placeholder={placeholder} aria-label={`${label} ${t('modelId')}`} dir="ltr" style={inputStyle} />
        <input value={provider} onChange={(e) => setProvider(e.target.value)} onBlur={commit} placeholder={t('provider')} aria-label={`${label} ${t('provider')}`} dir="ltr" style={inputStyle} />
      </div>
    </Field>
  )
}
