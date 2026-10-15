import { useT } from '../i18n'
import { PRESETS, type PresetId } from '../layout'
import { formatCost } from '../transcript'
import type { SessionInfo } from './Workbench'
import { Icon, Menu, MenuItem } from './ui'

/** The thin bar at the bottom: where you are, what runs, what it costs, and the layout controls. */
export function StatusBar({
  folder,
  info,
  inSession,
  preset,
  onPreset,
  onReset,
  onAgents,
  onDock,
  onSide,
  sideOpen,
  dockOpen,
  narrow,
}: {
  folder?: string | undefined
  info?: SessionInfo | undefined
  inSession: boolean
  preset: PresetId | null
  onPreset: (p: PresetId) => void
  onReset: () => void
  onAgents: () => void
  onDock: () => void
  onSide: () => void
  sideOpen: boolean
  dockOpen: boolean
  narrow: boolean
}) {
  const t = useT()
  const cost = info ? formatCost(info.costUsd, info.costPartial) : null
  return (
    <footer className="statusbar" role="contentinfo">
      {folder ? (
        <span className="sb-item clip" dir="ltr" title={folder}>
          <Icon name="file" size={13} /> {folder}
        </span>
      ) : null}
      {info ? (
        <>
          {info.model ? (
            <span className="sb-item clip mono" dir="ltr">
              {info.model}
            </span>
          ) : null}
          {info.agentsTotal > 0 ? (
            <button className={`sb-item sb-btn${info.agentsRunning ? ' sb-live' : ''}`} onClick={onAgents} title={t('ag_open')}>
              <Icon name="branch" size={13} />
              {info.agentsRunning ? <span className="pulse" aria-hidden="true" /> : null}
              <span className="num">{t('ag_status', { n: info.agentsRunning, total: info.agentsTotal })}</span>
            </button>
          ) : null}
          <span className="sb-item num" title={t('cost')}>
            {cost ?? t('unknown')}
            <span className="muted"> · {info.modelCalls} {t('calls')}</span>
          </span>
          {!info.connected ? <span className="sb-item sb-warn">{t('connecting')}</span> : null}
        </>
      ) : null}
      <span className="spacer" />
      {inSession ? (
        <>
          {!narrow ? (
            <button className="sb-item sb-btn" onClick={onDock} aria-pressed={dockOpen} title={`${t('wb_dock')} (Ctrl \`)`}>
              <Icon name="terminal" size={13} /> {t('wb_dock')}
            </button>
          ) : null}
          <button className="sb-item sb-btn" onClick={onSide} aria-pressed={sideOpen} title={`${t('details')} (Ctrl .)`}>
            <Icon name="panel" size={13} /> {t('details')}
          </button>
        </>
      ) : null}
      {!narrow ? (
        <Menu label={t('wb_layout')} icon="command" up>
          {(close) => (
            <>
              {PRESETS.map((p) => (
                <MenuItem key={p.id} icon={preset === p.id ? 'check' : undefined} onClick={() => (close(), onPreset(p.id))}>
                  {t(`wb_preset_${p.id}` as 'wb_preset_focus')}
                </MenuItem>
              ))}
              <MenuItem icon="x" onClick={() => (close(), onReset())}>
                {t('wb_resetLayout')}
              </MenuItem>
            </>
          )}
        </Menu>
      ) : null}
    </footer>
  )
}
