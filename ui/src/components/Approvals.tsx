import { useT } from '../i18n'
import type { PendingApproval } from '../types'
import { Button } from './ui'

/** The agent wants to change its own setup. Nothing happens until the owner answers here. */
export function Approvals({ items, onAnswer }: { items: PendingApproval[]; onAnswer: (id: string, approved: boolean) => void }) {
  const t = useT()
  if (!items.length) return null
  return (
    <div className="approvals" role="region" aria-label={t('ap_title')}>
      {items.map((r) => (
        <div key={r.id} className="approval-card" role="alertdialog" aria-label={r.title}>
          <div className="approval-head">
            <strong>{t('ap_title')}</strong>
            <span dir="auto">{r.title}</span>
          </div>
          {r.detail ? <pre className="approval-detail" dir="auto">{r.detail}</pre> : null}
          <div className="approval-actions">
            <Button kind="ghost" onClick={() => onAnswer(r.id, false)}>
              {t('ap_deny')}
            </Button>
            <Button kind="primary" onClick={() => onAnswer(r.id, true)}>
              {t('ap_allow')}
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}
