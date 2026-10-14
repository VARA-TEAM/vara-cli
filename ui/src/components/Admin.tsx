import qrcode from 'qrcode-generator'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { useT } from '../i18n'
import { formatCost, relativeTime, until } from '../transcript'
import type { CreatedInvite, Grant, GuestRecord, GuestRow, InviteRecord, ModelsInfo, Overview } from '../types'
import { Badge, Button, CopyButton, Dialog, Field, Icon, Switch } from './ui'

/** The same presets the host has (src/server/access.ts) — used only to prefill the form. */
export const PRESET_GRANTS: Record<'viewer' | 'participant' | 'collaborator', Grant> = {
  viewer: { preset: 'viewer', watch: true, sendShared: false, ownSession: false, modelPolicy: 'locked', allowedModels: [], mode: 'plan', canChangeMode: false, canInterrupt: false },
  participant: { preset: 'participant', watch: true, sendShared: true, ownSession: false, modelPolicy: 'locked', allowedModels: [], mode: 'plan', canChangeMode: false, canInterrupt: false },
  collaborator: { preset: 'collaborator', watch: true, sendShared: true, ownSession: true, modelPolicy: 'locked', allowedModels: [], mode: 'plan', canChangeMode: false, canInterrupt: false },
}

/** Only the fields that differ from the preset, so the host keeps the preset's name. */
export function grantOverrides(base: Grant, next: Grant): Partial<Grant> {
  const out: Partial<Grant> = {}
  for (const k of Object.keys(next) as Array<keyof Grant>) {
    if (k === 'preset') continue
    if (JSON.stringify(next[k]) !== JSON.stringify(base[k])) (out as Record<string, unknown>)[k] = next[k]
  }
  return out
}

export function QR({ text, size = 176 }: { text: string; size?: number }) {
  const cells = useMemo(() => {
    try {
      const q = qrcode(0, 'M')
      q.addData(text)
      q.make()
      const n = q.getModuleCount()
      let d = ''
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c},${r}h1v1h-1z`
      return { d, n }
    } catch {
      return null
    }
  }, [text])
  if (!cells) return null
  const quiet = 3
  return (
    <svg className="qr" width={size} height={size} viewBox={`${-quiet} ${-quiet} ${cells.n + quiet * 2} ${cells.n + quiet * 2}`} role="img" aria-label="QR" shapeRendering="crispEdges">
      <rect x={-quiet} y={-quiet} width={cells.n + quiet * 2} height={cells.n + quiet * 2} fill="#fff" />
      <path d={cells.d} fill="#111" />
    </svg>
  )
}

function GrantForm({ grant, onChange, models }: { grant: Grant; onChange: (g: Grant) => void; models: ModelsInfo | null }) {
  const t = useT()
  const set = <K extends keyof Grant>(k: K, v: Grant[K]): void => onChange({ ...grant, [k]: v, ...(k === 'mode' && v === 'plan' ? { canChangeMode: false } : {}) })
  const all = models && models.allowed !== 'any' ? models.allowed : []
  return (
    <div className="grant-form">
      <div className="switches">
        <Switch checked={grant.watch} onChange={(v) => set('watch', v)} label={t('canWatch')} />
        <Switch checked={grant.sendShared} onChange={(v) => set('sendShared', v)} label={t('canSendShared')} />
        <Switch checked={grant.ownSession} onChange={(v) => set('ownSession', v)} label={t('canOwn')} />
        <Switch checked={grant.canInterrupt} onChange={(v) => set('canInterrupt', v)} label={t('canInterrupt')} />
      </div>

      <Field label={t('agentPower')}>
        <select value={grant.mode} onChange={(e) => set('mode', e.target.value as Grant['mode'])}>
          <option value="plan">{t('power_plan')}</option>
          <option value="build">{t('power_build')}</option>
        </select>
      </Field>
      {grant.mode === 'build' ? (
        <div className="warn-box" role="alert">
          <Icon name="alert" size={18} /> {t('buildWarning')}
        </div>
      ) : null}
      <Switch checked={grant.canChangeMode} disabled={grant.mode === 'plan'} onChange={(v) => set('canChangeMode', v)} label={t('canChangeMode')} />

      <Field label={t('modelPolicy')}>
        <select value={grant.modelPolicy} onChange={(e) => set('modelPolicy', e.target.value as Grant['modelPolicy'])}>
          <option value="locked">{t('policy_locked')}</option>
          <option value="list">{t('policy_list')}</option>
          <option value="any">{t('policy_any')}</option>
        </select>
      </Field>
      {grant.modelPolicy === 'list' ? (
        <div className="model-pick" role="group" aria-label={t('modelPolicy')}>
          {(all.length ? all : [models?.current ?? '']).filter(Boolean).map((m) => (
            <label key={m} className="check">
              <input type="checkbox" checked={grant.allowedModels.includes(m)} onChange={(e) => set('allowedModels', e.target.checked ? [...grant.allowedModels, m] : grant.allowedModels.filter((x) => x !== m))} />
              <span className="mono">{m}</span>
            </label>
          ))}
        </div>
      ) : null}

      <div className="two">
        <Field label={t('maxCalls')}>
          <input type="number" min={1} inputMode="numeric" value={grant.maxModelCalls ?? ''} placeholder="∞" onChange={(e) => set('maxModelCalls', e.target.value ? Math.floor(Number(e.target.value)) : undefined)} />
        </Field>
        <Field label={t('maxCost')}>
          <input type="number" min={0} step="0.5" inputMode="decimal" value={grant.maxCostUsd ?? ''} placeholder="∞" onChange={(e) => set('maxCostUsd', e.target.value ? Number(e.target.value) : undefined)} />
        </Field>
      </div>
    </div>
  )
}

function InviteDialog({ models, onClose, onCreated }: { models: ModelsInfo | null; onClose: () => void; onCreated: () => void }) {
  const t = useT()
  const [preset, setPreset] = useState<'viewer' | 'participant' | 'collaborator'>('collaborator')
  const [grant, setGrant] = useState<Grant>(PRESET_GRANTS.collaborator)
  const [label, setLabel] = useState('')
  const [hours, setHours] = useState(24)
  const [uses, setUses] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedInvite | null>(null)

  const pick = (p: typeof preset): void => {
    setPreset(p)
    setGrant(PRESET_GRANTS[p])
  }
  const create = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const inv = await api<CreatedInvite>('POST', '/api/admin/invites', { preset, label, ttlMinutes: hours * 60, maxUses: uses, grant: grantOverrides(PRESET_GRANTS[preset], grant) })
      setCreated(inv)
      onCreated()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (created) {
    return (
      <Dialog title={t('inviteReady')} onClose={onClose}>
        <div className="invite-result">
          <QR text={created.link} />
          <div>
            <p className="muted">{t('scanQr')}</p>
            <input className="mono link-input" readOnly value={created.link} onFocus={(e) => e.currentTarget.select()} dir="ltr" aria-label={t('copyLink')} />
            <div className="row">
              <CopyButton text={created.link} label={t('copyLink')} />
            </div>
            {/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(created.link) ? <div className="warn-box" role="alert"><Icon name="alert" size={18} /> {t('loopbackHint')}</div> : null}
            <p className="warn-text">{t('inviteOnce')}</p>
          </div>
        </div>
        <div className="dialog-foot">
          <Button kind="primary" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog title={t('createInvite')} onClose={onClose} wide>
      <div className="preset-tabs" role="tablist">
        {(['viewer', 'participant', 'collaborator'] as const).map((p) => (
          <button key={p} role="tab" aria-selected={preset === p} className={preset === p ? 'on' : ''} onClick={() => pick(p)}>
            {t(`preset_${p}` as 'preset_viewer')}
          </button>
        ))}
      </div>
      <p className="muted">{t(`guestBanner_${preset}` as 'guestBanner_viewer')}</p>
      <Field label={t('label')}>
        <input value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} dir="auto" />
      </Field>
      <div className="two">
        <Field label={`${t('validFor')} (${t('hours')})`}>
          <input type="number" min={1} max={720} value={hours} onChange={(e) => setHours(Math.max(1, Number(e.target.value) || 1))} />
        </Field>
        <Field label={t('uses')}>
          <input type="number" min={1} max={100} value={uses} onChange={(e) => setUses(Math.max(1, Number(e.target.value) || 1))} />
        </Field>
      </div>
      <GrantForm grant={grant} onChange={setGrant} models={models} />
      {error ? <div className="inline-error" role="alert">{error}</div> : null}
      <div className="dialog-foot">
        <Button kind="ghost" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button kind="primary" icon="link" disabled={busy} onClick={() => void create()}>
          {t('createInvite')}
        </Button>
      </div>
    </Dialog>
  )
}

function EditDialog({ guest, models, onClose, onSaved }: { guest: GuestRecord; models: ModelsInfo | null; onClose: () => void; onSaved: () => void }) {
  const t = useT()
  const [grant, setGrant] = useState<Grant>(guest.grant)
  const [error, setError] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    try {
      await api('PATCH', `/api/admin/guests/${guest.id}`, { grant })
      onSaved()
      onClose()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <Dialog title={`${t('edit')} · ${guest.name}`} onClose={onClose} wide>
      <GrantForm grant={grant} onChange={setGrant} models={models} />
      {error ? <div className="inline-error" role="alert">{error}</div> : null}
      <div className="dialog-foot">
        <Button kind="ghost" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button kind="primary" onClick={() => void save()}>
          {t('save')}
        </Button>
      </div>
    </Dialog>
  )
}

/** Owner only: who is in, what they may do, what they use. */
export function Team({ models, onOpenSession, onToggleSidebar }: { models: ModelsInfo | null; onOpenSession: (id: string) => void; onToggleSidebar: () => void }) {
  const t = useT()
  const [overview, setOverview] = useState<Overview | null>(null)
  const [records, setRecords] = useState<GuestRecord[]>([])
  const [invites, setInvites] = useState<InviteRecord[]>([])
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<GuestRecord | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    Promise.all([api<Overview>('GET', '/api/admin/overview'), api<GuestRecord[]>('GET', '/api/admin/guests'), api<InviteRecord[]>('GET', '/api/admin/invites')])
      .then(([o, g, i]) => {
        setOverview(o)
        setRecords(g)
        setInvites(i)
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
  }, [])
  useEffect(() => {
    load()
    const id = setInterval(load, 5000)
    return () => clearInterval(id)
  }, [load])

  const guests: GuestRow[] = (overview?.guests ?? []).filter((g) => !g.revoked)
  const openInvites = invites.filter((i) => !i.revoked && i.uses < i.maxUses && Date.parse(i.expiresAt) > Date.now())

  return (
    <main className="page">
      <header className="page-head">
        <button className="icon-btn only-narrow" onClick={onToggleSidebar} aria-label={t('sessions')}>
          <Icon name="menu" />
        </button>
        <h1>{t('team')}</h1>
        <Button kind="primary" icon="plus" onClick={() => setCreating(true)}>
          {t('createInvite')}
        </Button>
      </header>
      {error ? <div className="inline-error" role="alert">{error}</div> : null}

      <section className="card">
        <h2>{t('guests')}</h2>
        {guests.length === 0 ? (
          <p className="muted pad">{t('noGuests')}</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('name')}</th>
                  <th>{t('preset')}</th>
                  <th>{t('lastSeen')}</th>
                  <th>{t('sessions')}</th>
                  <th>{t('calls')}</th>
                  <th>{t('cost')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {guests.map((g) => {
                  const rec = records.find((r) => r.id === g.id)
                  const sessions = overview?.sessions.filter((s) => s.participant?.id === g.id) ?? []
                  return (
                    <tr key={g.id}>
                      <td dir="auto">
                        <strong>{g.name}</strong>
                      </td>
                      <td>
                        <Badge tone={rec?.grant.mode === 'build' ? 'warn' : 'muted'}>{t(`preset_${g.preset}` as 'preset_viewer')}</Badge>
                        {rec?.grant.mode === 'build' ? <Badge tone="warn">build</Badge> : null}
                      </td>
                      <td className="muted">{relativeTime(g.lastSeenAt)}</td>
                      <td>
                        {sessions.length ? (
                          <button className="link-btn" onClick={() => onOpenSession(sessions[0]!.id)}>
                            {g.sessions}
                            {g.running ? ` · ${g.running} ${t('running_n')}` : ''}
                          </button>
                        ) : (
                          g.sessions
                        )}
                      </td>
                      <td>{g.modelCalls}</td>
                      <td>{g.modelCalls === 0 ? '—' : (formatCost(g.costUsd) ?? t('unknown'))}</td>
                      <td className="actions">
                        {rec ? (
                          <Button small kind="ghost" icon="settings" onClick={() => setEditing(rec)}>
                            {t('edit')}
                          </Button>
                        ) : null}
                        <Button
                          small
                          kind="danger"
                          icon="x"
                          onClick={() => {
                            if (window.confirm(t('confirmRevoke'))) void api('DELETE', `/api/admin/guests/${g.id}`).then(load)
                          }}
                        >
                          {t('revoke')}
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>{t('openInvites')}</h2>
        {openInvites.length === 0 ? (
          <p className="muted pad">{t('noInvites')}</p>
        ) : (
          <ul className="invite-list">
            {openInvites.map((i) => (
              <li key={i.id}>
                <Badge>{t(`preset_${i.grant.preset}` as 'preset_viewer')}</Badge>
                <span dir="auto">{i.label || i.id}</span>
                <span className="muted">
                  {i.uses}/{i.maxUses} · {t('expires')} {until(i.expiresAt)}
                </span>
                <Button small kind="ghost" icon="trash" title={t('revoke')} onClick={() => void api('DELETE', `/api/admin/invites/${i.id}`).then(load)} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {creating ? <InviteDialog models={models} onClose={() => setCreating(false)} onCreated={load} /> : null}
      {editing ? <EditDialog guest={editing} models={models} onClose={() => setEditing(null)} onSaved={load} /> : null}
    </main>
  )
}
