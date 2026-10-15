import { fmtTokens, fmtUsd, levelColor, useCostBoard, useCostT, type CostStatus } from './CostShared'

/**
 * A compact "how much of my limit is left" meter: a bar, the percentage, and one
 * honest sentence about the pace. Self-contained: place it anywhere (sidebar,
 * side panel, header). It fetches by itself and shows nothing at all for a
 * guest (the cost board is owner-only), so it is always safe to render.
 */
export function CostMeter({ compact = false }: { compact?: boolean }) {
  const t = useCostT()
  const { data, error } = useCostBoard()
  if (error || !data) return null
  const st = data.status
  if (!st.configured) {
    return compact ? null : (
      <p className="muted" style={{ fontSize: 13 }} dir="auto">
        {t('noLimit')}
      </p>
    )
  }
  return <MeterBody st={st} compact={compact} />
}

export function MeterBody({ st, compact }: { st: CostStatus; compact: boolean }) {
  const t = useCostT()
  const pct = st.percent === null ? null : Math.max(0, Math.min(100, st.percent))
  const color = levelColor(st.level)
  const used = st.unit === 'usd' ? fmtUsd(st.used) : fmtTokens(st.used)
  const limit = st.limit === null ? null : st.unit === 'usd' ? fmtUsd(st.limit) : fmtTokens(st.limit)
  return (
    <div style={{ display: 'grid', gap: 6 }} role="group" aria-label={t('title')}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <strong style={{ fontSize: compact ? 13 : 14 }}>{t('title')}</strong>
        <span className="mono" style={{ color }} dir="ltr">
          {st.percent === null ? '—' : `${Math.round(st.percent)}%`}
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct === null ? undefined : Math.round(pct)}
        style={{ height: 8, borderRadius: 4, background: 'var(--surface-2)', overflow: 'hidden', border: '1px solid var(--border)' }}
      >
        <div style={{ width: `${pct ?? 0}%`, height: '100%', background: color, transition: 'width .4s ease' }} />
      </div>
      {!compact ? (
        <>
          <span className="muted" style={{ fontSize: 13 }} dir="auto">
            {limit ? `${used} ${t('of')} ${limit} ${t('used')}` : ''}
            {st.resetsAt ? ` · ${t('resets')} ${new Date(st.resetsAt).toLocaleString()}` : ''}
          </span>
          <span style={{ fontSize: 13 }} dir="auto">
            {paceLine(st, t)}
          </span>
          {st.unknownCalls ? (
            <span className="muted" style={{ fontSize: 12 }} dir="auto">
              {st.unknownCalls} {t('unreported')}
            </span>
          ) : null}
        </>
      ) : (
        <span className="muted" style={{ fontSize: 12 }} dir="auto">
          {paceLine(st, t)}
        </span>
      )}
    </div>
  )
}

function paceLine(st: CostStatus, t: ReturnType<typeof useCostT>): string {
  if (st.hoursLeft === null) return `${t('pace')}: ${t('noPace')}`
  if (st.lastsUntilReset) return `${t('pace')}: ${t('lastsReset')}`
  const h = st.hoursLeft
  return `${t('pace')}: ${t('lasts')} ${h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${h.toFixed(1)} ${t('hours')}`}`
}
