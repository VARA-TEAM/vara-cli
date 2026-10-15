import { useContext, useMemo } from 'react'
import { RegistryContext } from '../commands'
import { useT, type Key } from '../i18n'
import { Dialog } from './ui'

/** Browser key → the terminal key it stands for. Differences exist only where the browser owns the terminal's key. */
export const SHORTCUTS: Array<{ web: string; tui: string; what: Key }> = [
  { web: 'Ctrl K', tui: 'Ctrl+K', what: 'hk_palette' },
  { web: 'Ctrl Shift O', tui: 'Ctrl+N', what: 'hk_new' },
  { web: 'Ctrl O', tui: 'Ctrl+O', what: 'hk_settings' },
  { web: 'Ctrl B', tui: 'Ctrl+B', what: 'hk_sidebar' },
  { web: 'Ctrl .', tui: 'Ctrl+B', what: 'hk_side' },
  { web: 'Ctrl Shift A', tui: '—', what: 'hk_agents' },
  { web: 'Ctrl `', tui: '—', what: 'hk_dock' },
  { web: 'Ctrl \\', tui: '—', what: 'hk_split' },
  { web: 'Alt ← / Alt →', tui: 'Alt+← / Alt+→', what: 'hk_tabs' },
  { web: 'Alt Shift ← / →', tui: '—', what: 'hk_reorder' },
  { web: 'Alt W', tui: 'Ctrl+W', what: 'hk_close' },
  { web: 'Alt M', tui: 'Tab', what: 'hk_mode' },
  { web: 'Ctrl G', tui: 'Ctrl+G', what: 'hk_latest' },
  { web: 'Ctrl J', tui: 'Ctrl+J', what: 'hk_newline' },
  { web: 'Enter / Shift Enter', tui: 'Enter / Ctrl+J', what: 'hk_send' },
  { web: 'Esc Esc', tui: 'Esc Esc', what: 'hk_pause' },
  { web: 'Esc', tui: 'Esc', what: 'hk_esc' },
  { web: 'Enter · ← → · Shift · Home End', tui: '—', what: 'hk_resize' },
]

/** `/help`: every command you may use right now, and the keys. */
export function Help({ onClose }: { onClose: () => void }) {
  const t = useT()
  const reg = useContext(RegistryContext)
  const cmds = useMemo(() => reg.all().filter((c) => c.slash && !c.id.startsWith('skill:')), [reg])
  const seen = new Set<string>()
  const unique = cmds.filter((c) => (seen.has(c.slash!) ? false : (seen.add(c.slash!), true))).sort((a, b) => a.slash!.localeCompare(b.slash!))
  return (
    <Dialog title={t('cmd_help')} onClose={onClose} wide>
      <h3 className="sec first">{t('hk_commands')}</h3>
      <dl className="keys">
        {unique.map((c) => (
          <div key={c.id}>
            <dt className="mono" dir="ltr">
              /{c.slash}
              {c.args ? ` ${c.args}` : ''}
            </dt>
            <dd>{c.description ?? c.title}</dd>
          </div>
        ))}
      </dl>
      <p className="muted small">{t('hk_other')}</p>
      <h3 className="sec">{t('hk_keys')}</h3>
      <table className="data keys-table">
        <thead>
          <tr>
            <th>{t('hk_action')}</th>
            <th>{t('hk_web')}</th>
            <th>{t('hk_terminal')}</th>
          </tr>
        </thead>
        <tbody>
          {SHORTCUTS.map((s) => (
            <tr key={s.web + s.what}>
              <td>{t(s.what)}</td>
              <td dir="ltr">
                <kbd>{s.web}</kbd>
              </td>
              <td dir="ltr" className="muted">
                {s.tui}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">{t('hk_note')}</p>
    </Dialog>
  )
}
