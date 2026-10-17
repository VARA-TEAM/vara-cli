import { useContext, useState } from 'react'
import { LangContext, useT, type Lang } from '../i18n'
import { useResource } from '../hooks'
import { usePrefs } from '../prefs'
import { ACCENT_IDS, DENSITY_IDS, FONTS, THEMES, applyAccent, applyDensity, applyFont, savedAccent, savedDensity, savedFont, type AccentId, type DensityId, type Theme } from '../theme'
import type { Grant, McpState, Me, MemoryState, ModeRow, ProposalRow, ProvidersState, SettingsState, SkillRow } from '../types'
import { AgentPanel, Row } from './Agent'
import { ConnectorsPanel, type ConnectorRow } from './Connectors'
import { GatewaysPanel, type GatewayState } from './Gateways'
import { McpPanel } from './Mcp'
import { Providers } from './Providers'
import { SkillsPanel } from './Skills'
import { MemoryPanel } from './Memory'
import { ProposalsPanel } from './Proposals'
import { ModesPanel } from './Modes'
import { Icon, Switch } from './ui'

export type SettingsTab = 'models' | 'agent' | 'skills' | 'memory' | 'connectors' | 'gateways' | 'mcp' | 'look' | 'about'
export const OWNER_TABS: SettingsTab[] = ['models', 'agent', 'skills', 'memory', 'connectors', 'gateways', 'mcp', 'look', 'about']
export const GUEST_TABS: SettingsTab[] = ['look', 'about']
export const isTab = (v: string | undefined): v is SettingsTab => !!v && (OWNER_TABS as string[]).includes(v)

const TAB_ICON: Record<SettingsTab, string> = { models: 'spark', agent: 'settings', skills: 'file', memory: 'file', connectors: 'share', gateways: 'link', mcp: 'link', look: 'eye', about: 'shield' }

function describeGrant(g: Grant, t: ReturnType<typeof useT>): string[] {
  const out: string[] = []
  if (g.watch) out.push(t('canWatch'))
  if (g.sendShared) out.push(t('canSendShared'))
  if (g.ownSession) out.push(t('canOwn'))
  out.push(g.mode === 'plan' ? t('readonlyAgent') : t('yourAgentBuild'))
  if (g.maxModelCalls) out.push(`${t('maxCalls')}: ${g.maxModelCalls}`)
  if (g.maxCostUsd) out.push(`${t('maxCost')}: ${g.maxCostUsd}`)
  return out
}

function Look({ theme, onTheme, owner }: { theme: Theme; onTheme: (t: Theme) => void; owner: boolean }) {
  const t = useT()
  const { lang, setLang } = useContext(LangContext)
  const { prefs, setPrefs } = usePrefs()
  const [font, setFont] = useState(savedFont)
  const [accent, setAccent] = useState<AccentId>(savedAccent)
  const [density, setDensity] = useState<DensityId>(savedDensity)
  const fromTokens = theme.id === 'system' || theme.id === 'vara' || theme.id === 'light'
  return (
    <div>
      <h3 className="sec first">{t('theme')}</h3>
      <div className="theme-grid" role="radiogroup" aria-label={t('theme')}>
        {THEMES.map((th) => (
          <button key={th.id} role="radio" aria-checked={th.id === theme.id} className={`theme-card${th.id === theme.id ? ' on' : ''}`} onClick={() => onTheme(th)}>
            <span className="swatch" style={{ background: th.bg, borderColor: th.border }}>
              <i style={{ background: th.brand }} />
              <i style={{ background: th.accent }} />
              <i style={{ background: th.user }} />
            </span>
            {th.label}
          </button>
        ))}
      </div>

      {fromTokens ? (
        <>
          <h3 className="sec">{t('accent')}</h3>
          <div className="accent-row" role="radiogroup" aria-label={t('accent')}>
            {ACCENT_IDS.map((a) => (
              <button key={a} role="radio" aria-checked={a === accent} aria-label={t(`accent_${a}` as never)} title={t(`accent_${a}` as never)} className={`accent-dot${a === accent ? ' on' : ''}`} data-accent={a} onClick={() => (applyAccent(a), setAccent(a))}>
                <i />
              </button>
            ))}
          </div>
        </>
      ) : null}

      <h3 className="sec">{t('density')}</h3>
      <div className="seg" role="radiogroup" aria-label={t('density')}>
        {DENSITY_IDS.map((d) => (
          <button key={d} role="radio" aria-checked={d === density} className={d === density ? 'on' : ''} onClick={() => (applyDensity(d), setDensity(d))}>
            {t(`density_${d}` as never)}
          </button>
        ))}
      </div>

      <h3 className="sec">{t('font')}</h3>
      <div className="font-grid" role="radiogroup" aria-label={t('font')}>
        {FONTS.map((f) => (
          <button key={f.id} role="radio" aria-checked={f.id === font} className={`font-card${f.id === font ? ' on' : ''}`} data-font-preview={f.id} onClick={() => (applyFont(f.id), setFont(f.id))}>
            <span className="font-aa" aria-hidden="true">Aa أب</span>
            <span className="font-name">{f.label}{f.id === 'vara' ? ` · ${t('font_default')}` : ''}</span>
            <span className="muted font-sample">{f.sample}</span>
          </button>
        ))}
      </div>

      <h3 className="sec">{t('language')}</h3>
      <div className="seg" role="radiogroup" aria-label={t('language')}>
        {(['en', 'ar'] as Lang[]).map((l) => (
          <button key={l} role="radio" aria-checked={lang === l} className={lang === l ? 'on' : ''} onClick={() => setLang(l)}>
            {l === 'en' ? 'English' : 'العربية'}
          </button>
        ))}
      </div>

      <h3 className="sec">{t('l_session')}</h3>
      {owner ? (
        <Row label={t('l_thinking')} help={t('l_thinkingHelp')}>
          <Switch checked={prefs.showThinking} onChange={(v) => setPrefs({ showThinking: v })} label={prefs.showThinking ? t('on') : t('off')} />
        </Row>
      ) : null}
      <Row label={t('l_toolDetails')} help={t('l_toolDetailsHelp')}>
        <Switch checked={prefs.toolDetails} onChange={(v) => setPrefs({ toolDetails: v })} label={prefs.toolDetails ? t('on') : t('off')} />
      </Row>
      <Row label={t('l_panel')} help={t('l_panelHelp')}>
        <Switch checked={prefs.panel} onChange={(v) => setPrefs({ panel: v })} label={prefs.panel ? t('on') : t('off')} />
      </Row>
    </div>
  )
}

const SHORTCUTS: Array<[string, 'k_palette' | 'k_new' | 'k_panel' | 'k_send' | 'k_newline' | 'k_mention' | 'k_slash']> = [
  ['Ctrl K', 'k_palette'],
  ['Ctrl Shift O', 'k_new'],
  ['Ctrl .', 'k_panel'],
  ['Enter', 'k_send'],
  ['Shift Enter', 'k_newline'],
  ['@', 'k_mention'],
  ['/', 'k_slash'],
]

function About({ me }: { me: Me }) {
  const t = useT()
  return (
    <div>
      <h3 className="sec first">{t('host')}</h3>
      <dl className="kv wide">
        <dt>{t('folder')}</dt>
        <dd className="mono" dir="ltr">{me.host.folder}</dd>
        <dt>{t('provider')}</dt>
        <dd className="mono" dir="ltr">
          {me.host.provider} · {me.host.model}
        </dd>
        <dt>{t('version')}</dt>
        <dd className="mono">{me.host.version}</dd>
      </dl>
      {me.role === 'guest' ? (
        <>
          <h3 className="sec">
            {t('youAre')} {me.name}
          </h3>
          <ul className="plain">
            {describeGrant(me.grant, t).map((s) => (
              <li key={s}>
                <Icon name="check" size={14} /> {s}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h3 className="sec">{t('k_title')}</h3>
      <dl className="keys">
        {SHORTCUTS.map(([k, label]) => (
          <div key={k}>
            <dt>
              {k.split(' ').map((p) => (
                <kbd key={p}>{p}</kbd>
              ))}
            </dt>
            <dd>{t(label)}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** Settings: for the owner everything the terminal's /providers, /settings, /skills and /mcp offer; for a guest, how it looks and what they may do. */
export function Settings({ me, tab, onTab, theme, onTheme, onToggleSidebar }: { me: Me; tab: SettingsTab; onTab: (t: SettingsTab) => void; theme: Theme; onTheme: (t: Theme) => void; onToggleSidebar: () => void }) {
  const t = useT()
  const owner = me.role === 'owner'
  const tabs = owner ? OWNER_TABS.filter((x) => x !== 'gateways' || me.features?.gateways !== false) : GUEST_TABS
  const active = tabs.includes(tab) ? tab : tabs[0]!
  const providers = useResource<ProvidersState>(owner && (active === 'models' || active === 'agent') ? '/api/manage/providers' : null)
  const settings = useResource<SettingsState>(owner && active === 'agent' ? '/api/manage/settings' : null)
  const modes = useResource<ModeRow[]>(owner && active === 'agent' ? '/api/manage/modes' : null)
  const skills = useResource<SkillRow[]>(owner && active === 'skills' ? '/api/manage/skills' : null)
  const memory = useResource<MemoryState>(owner && active === 'memory' ? '/api/manage/memory' : null)
  const proposals = useResource<ProposalRow[]>(owner && active === 'skills' ? '/api/manage/skill-proposals' : null)
  const connectors = useResource<ConnectorRow[]>(owner && active === 'connectors' ? '/api/manage/connectors' : null)
  const gateways = useResource<GatewayState>(owner && active === 'gateways' ? '/api/manage/gateways' : null)
  const mcp = useResource<McpState>(owner && active === 'mcp' ? '/api/manage/mcp' : null)
  const modelIds = providers.data?.providers.find((p) => p.active)?.models.map((m) => m.id) ?? []
  const label: Record<SettingsTab, string> = { models: t('t_models'), agent: t('t_agent'), skills: t('t_skills'), memory: t('t_memory'), connectors: t('t_connectors'), gateways: t('t_gateways'), mcp: t('t_mcp'), look: t('t_look'), about: t('t_about') }

  return (
    <main className="page settings">
      <header className="page-head">
        <button className="icon-btn only-narrow" onClick={onToggleSidebar} aria-label={t('sessions')}>
          <Icon name="menu" />
        </button>
        <h1>{label[active]}</h1>
      </header>
      <div className="settings-layout">
        <nav className="settings-tabs" role="tablist" aria-label={t('settings')}>
          {tabs.map((id) => (
            <button key={id} role="tab" aria-selected={id === active} className={id === active ? 'on' : ''} onClick={() => onTab(id)}>
              <Icon name={TAB_ICON[id]} size={16} />
              <span>{label[id]}</span>
            </button>
          ))}
        </nav>
        <div className="settings-body" role="tabpanel">
          {providers.error && owner && (active === 'models' || active === 'agent') ? <div className="inline-error">{providers.error}</div> : null}
          {active === 'models' ? <Providers state={providers.data} reload={providers.reload} set={providers.set} /> : null}
          {active === 'agent' ? (
            <>
              <AgentPanel state={settings.data} set={settings.set} models={modelIds} />
              <ModesPanel modes={modes.data} set={modes.set} />
            </>
          ) : null}
          {active === 'skills' ? (
            <>
              <ProposalsPanel rows={proposals.data} set={proposals.set} onInstalled={skills.reload} />
              <SkillsPanel skills={skills.data} set={skills.set} />
            </>
          ) : null}
          {active === 'memory' ? <MemoryPanel state={memory.data} set={memory.set} /> : null}
          {active === 'connectors' ? <ConnectorsPanel rows={connectors.data} set={connectors.set} /> : null}
          {active === 'gateways' ? <GatewaysPanel state={gateways.data} set={gateways.set} /> : null}
          {active === 'mcp' ? <McpPanel state={mcp.data} set={mcp.set} reload={mcp.reload} /> : null}
          {active === 'look' ? <Look theme={theme} onTheme={onTheme} owner={owner} /> : null}
          {active === 'about' ? <About me={me} /> : null}
        </div>
      </div>
    </main>
  )
}
