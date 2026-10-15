import { useState } from 'react'
import { api } from '../api'
import { useT } from '../i18n'
import type { ProposalRow } from '../types'
import { useAct } from './toast'
import { Badge, Button, Dialog } from './ui'

const BASE = '/api/manage/skill-proposals'

/** Skills the agent proposed. Nothing here is installed: approving writes the skill, rejecting deletes the proposal. */
export function ProposalsPanel({ rows, set, onInstalled }: { rows: ProposalRow[] | null; set: (r: ProposalRow[]) => void; onInstalled: () => void }) {
  const t = useT()
  const { busy, act } = useAct()
  const [open, setOpen] = useState<ProposalRow | null>(null)
  if (!rows || !rows.length) return null
  const decide = (p: ProposalRow, approve: boolean) =>
    void act(
      approve ? 'approve' : 'reject',
      () => (approve ? api<ProposalRow[]>('POST', `${BASE}/${p.id}/approve`, {}) : api<ProposalRow[]>('DELETE', `${BASE}/${p.id}`)),
      approve ? t('pr_installed') : undefined,
    ).then((r) => {
      if (!r) return
      set(r)
      if (approve) onInstalled()
      setOpen(null)
    })
  return (
    <section>
      <h3 className="sec">{t('pr_title')}</h3>
      <p className="muted">{t('pr_sub')}</p>
      <ul className="rows">
        {rows.map((p) => (
          <li key={p.id} className="rowitem">
            <div className="rowitem-main">
              <div className="rowitem-title">
                <strong className="mono" dir="ltr">{p.name}</strong>
                <Badge tone="accent">{p.scope}</Badge>
                {p.replaces !== 'none' ? <Badge tone="warn">{t('pr_replaces', { what: p.replaces })}</Badge> : null}
              </div>
              <span className="muted" dir="auto">{p.description}</span>
            </div>
            <Button small kind="ghost" onClick={() => setOpen(p)}>
              {t('s_view')}
            </Button>
          </li>
        ))}
      </ul>
      {open ? (
        <Dialog title={<span className="mono" dir="ltr">{open.name}</span>} onClose={() => setOpen(null)} wide>
          <p className="muted" dir="auto">{open.reason}</p>
          <textarea className="code-edit" value={open.body} readOnly rows={14} dir="ltr" aria-label={open.name} />
          <div className="dialog-foot">
            <Button kind="ghost" disabled={!!busy} onClick={() => decide(open, false)}>
              {t('pr_reject')}
            </Button>
            <Button kind="primary" disabled={!!busy} onClick={() => decide(open, true)}>
              {t('pr_approve')}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </section>
  )
}
