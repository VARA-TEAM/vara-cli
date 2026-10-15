import { useState } from 'react'
import { api } from '../api'
import { useT } from '../i18n'
import type { ModeRow } from '../types'
import { useAct } from './toast'
import { Badge, Button, Dialog, Field } from './ui'

const BASE = '/api/manage/modes'
const lines = (v: string): string[] => v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)

function Editor({ mode, onClose, onSaved }: { mode: ModeRow | null; onClose: () => void; onSaved: (m: ModeRow[]) => void }) {
  const t = useT()
  const { busy, act } = useAct()
  const [name, setName] = useState(mode?.name ?? '')
  const [description, setDescription] = useState(mode?.description ?? '')
  const [base, setBase] = useState<'plan' | 'build'>(mode?.base ?? 'build')
  const [allowTools, setAllowTools] = useState((mode?.allowTools ?? []).join('\n'))
  const [denyTools, setDenyTools] = useState((mode?.denyTools ?? []).join('\n'))
  const [allowCommands, setAllowCommands] = useState((mode?.allowCommands ?? []).join('\n'))
  const [denyCommands, setDenyCommands] = useState((mode?.denyCommands ?? []).join('\n'))
  const valid = /^[a-z][a-z0-9_-]{0,29}$/.test(name) && name !== 'plan' && name !== 'build'
  const area = (v: string, set: (s: string) => void, label: string, hint: string) => (
    <Field label={label} hint={hint}>
      <textarea className="code-edit" rows={3} value={v} onChange={(e) => set(e.target.value)} spellCheck={false} dir="ltr" aria-label={label} />
    </Field>
  )
  return (
    <Dialog title={mode ? mode.name : t('m_new')} onClose={onClose} wide>
      <Field label={t('m_name')} hint={t('m_nameHelp')}>
        <input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} disabled={!!mode} dir="ltr" aria-label={t('m_name')} />
      </Field>
      <Field label={t('m_desc')}>
        <input value={description} onChange={(e) => setDescription(e.target.value)} aria-label={t('m_desc')} />
      </Field>
      <Field label={t('m_base')} hint={t('m_baseHelp')}>
        <select value={base} onChange={(e) => setBase(e.target.value as 'plan' | 'build')} aria-label={t('m_base')}>
          <option value="plan">{t('mode_plan')}</option>
          <option value="build">{t('mode_build')}</option>
        </select>
      </Field>
      {area(allowTools, setAllowTools, t('m_allowTools'), t('m_allowToolsHelp'))}
      {area(denyTools, setDenyTools, t('m_denyTools'), t('m_listHelp'))}
      {area(allowCommands, setAllowCommands, t('m_allowCmds'), t('m_allowCmdsHelp'))}
      {area(denyCommands, setDenyCommands, t('m_denyCmds'), t('m_listHelp'))}
      <div className="dialog-foot">
        <Button kind="ghost" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button
          kind="primary"
          disabled={!!busy || !valid}
          onClick={() =>
            void act('save', () => api<ModeRow[]>('PUT', `${BASE}/${encodeURIComponent(name)}`, { description, base, allowTools: lines(allowTools), denyTools: lines(denyTools), allowCommands: lines(allowCommands), denyCommands: lines(denyCommands) }), t('saved')).then((r) => r && (onSaved(r), onClose()))
          }
        >
          {t('save')}
        </Button>
      </div>
    </Dialog>
  )
}

/** Settings → Agent → custom modes: named restrictions of plan or build. */
export function ModesPanel({ modes, set }: { modes: ModeRow[] | null; set: (m: ModeRow[]) => void }) {
  const t = useT()
  const { busy, act } = useAct()
  const [editing, setEditing] = useState<ModeRow | 'new' | null>(null)
  return (
    <div className="modes-panel">
      <h3 className="sec">{t('m_title')}</h3>
      <p className="muted">{t('m_help')}</p>
      {(modes ?? []).map((m) => (
        <div key={m.name} className="srow">
          <div className="srow-label">
            <strong dir="ltr">{m.name}</strong> <Badge tone={m.base === 'plan' ? 'warn' : 'ok'}>{t(m.base === 'plan' ? 'mode_plan' : 'mode_build')}</Badge>
            <span className="muted">{m.description}</span>
          </div>
          <div className="srow-control">
            <Button kind="ghost" onClick={() => setEditing(m)}>
              {t('edit')}
            </Button>
            <Button kind="ghost" disabled={!!busy} onClick={() => void act('delete', () => api<ModeRow[]>('DELETE', `${BASE}/${encodeURIComponent(m.name)}`), t('saved')).then((r) => r && set(r))}>
              {t('remove')}
            </Button>
          </div>
        </div>
      ))}
      <Button kind="primary" onClick={() => setEditing('new')}>
        {t('m_new')}
      </Button>
      {editing ? <Editor mode={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={set} /> : null}
    </div>
  )
}
