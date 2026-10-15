import { useT } from '../i18n'
import type { McpServerRow, SessionView, SkillRow } from '../types'
import { Switch } from './ui'

/** Per-session switches: skills and MCP servers (connectors) this conversation may use. Other sessions keep their own. */
export function SessionTools({ view, skills, servers, onToggle }: { view: SessionView; skills: SkillRow[]; servers: McpServerRow[]; onToggle: (kind: 'skill' | 'mcp', name: string, enabled: boolean) => void }) {
  const t = useT()
  const skillRows = skills.filter((s) => s.enabled)
  const serverRows = servers.filter((s) => s.enabled)
  return (
    <div className="session-tools">
      <p className="muted">{t('st_help')}</p>
      <h3 className="sec">{t('t_skills')}</h3>
      {skillRows.length ? (
        skillRows.map((s) => (
          <div key={s.name} className="srow">
            <div className="srow-label">
              <strong dir="ltr">{s.name}</strong>
              <span className="muted">{s.description}</span>
            </div>
            <Switch checked={!view.disabledSkills.includes(s.name)} onChange={(v) => onToggle('skill', s.name, v)} label={view.disabledSkills.includes(s.name) ? t('off') : t('on')} />
          </div>
        ))
      ) : (
        <p className="muted">{t('st_none')}</p>
      )}
      <h3 className="sec">{t('t_mcp')}</h3>
      {serverRows.length ? (
        serverRows.map((s) => (
          <div key={s.name} className="srow">
            <div className="srow-label">
              <strong dir="ltr">{s.name}</strong>
              <span className="muted">{t('st_tools', { n: s.tools })}</span>
            </div>
            <Switch checked={!view.disabledMcp.includes(s.name)} onChange={(v) => onToggle('mcp', s.name, v)} label={view.disabledMcp.includes(s.name) ? t('off') : t('on')} />
          </div>
        ))
      ) : (
        <p className="muted">{t('st_none')}</p>
      )}
    </div>
  )
}
