import { useEffect, useState } from 'react'
import { api } from '../api'
import { useT } from '../i18n'
import type { SkillRow } from '../types'
import { useAct } from './toast'
import { Badge, Button, Dialog, Field, Switch } from './ui'

const BASE = '/api/manage/skills'

function Editor({ skill, onClose, onSaved }: { skill: SkillRow; onClose: () => void; onSaved: (s: SkillRow[]) => void }) {
  const t = useT()
  const { busy, act } = useAct()
  const [text, setText] = useState<string | null>(null)
  // Load the raw file (front matter included) when the dialog opens.
  useEffect(() => {
    let live = true
    api<{ content: string }>('GET', `${BASE}/${encodeURIComponent(skill.name)}/source`)
      .then((r) => live && setText(r.content))
      .catch(() => live && setText(skill.body))
    return () => {
      live = false
    }
  }, [skill])
  if (text === null) {
    return (
      <Dialog title={skill.name} onClose={onClose} wide>
        <p className="muted pad">{t('loading')}</p>
      </Dialog>
    )
  }
  return (
    <Dialog title={<span className="mono" dir="ltr">{skill.name}</span>} onClose={onClose} wide>
      <p className="muted">{skill.editable ? t('s_editHelp') : t('s_builtinHelp')}</p>
      <textarea className="code-edit" value={text} onChange={(e) => setText(e.target.value)} readOnly={!skill.editable} spellCheck={false} dir="ltr" rows={16} aria-label={skill.name} />
      <div className="dialog-foot">
        <Button kind="ghost" onClick={onClose}>
          {skill.editable ? t('cancel') : t('close')}
        </Button>
        {skill.editable ? (
          <Button
            kind="primary"
            disabled={!!busy || !text.trim()}
            onClick={() =>
              void act('save', () => api<SkillRow[]>('PATCH', `${BASE}/${encodeURIComponent(skill.name)}`, { content: text }), t('saved')).then((r) => r && (onSaved(r), onClose()))
            }
          >
            {t('save')}
          </Button>
        ) : null}
      </div>
    </Dialog>
  )
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (s: SkillRow[], name: string) => void }) {
  const t = useT()
  const { busy, act } = useAct()
  const [name, setName] = useState('')
  const [scope, setScope] = useState<'user' | 'project'>('user')
  const valid = /^[a-z0-9][a-z0-9_-]{0,39}$/.test(name)
  return (
    <Dialog title={t('s_new')} onClose={onClose}>
      <Field label={t('p_name')} hint={t('s_nameHint')}>
        <input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} dir="ltr" maxLength={40} autoFocus placeholder="release-notes" />
      </Field>
      <Field label={t('s_where')}>
        <div className="seg" role="radiogroup" aria-label={t('s_where')}>
          <button role="radio" aria-checked={scope === 'user'} className={scope === 'user' ? 'on' : ''} onClick={() => setScope('user')}>
            {t('s_everywhere')}
          </button>
          <button role="radio" aria-checked={scope === 'project'} className={scope === 'project' ? 'on' : ''} onClick={() => setScope('project')}>
            {t('s_thisProject')}
          </button>
        </div>
      </Field>
      <div className="dialog-foot">
        <Button kind="ghost" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button kind="primary" disabled={!valid || !!busy} onClick={() => void act('create', () => api<SkillRow[]>('POST', BASE, { name, scope })).then((r) => r && (onCreated(r, name), onClose()))}>
          {t('s_create')}
        </Button>
      </div>
    </Dialog>
  )
}

/** Settings → Skills: playbooks the agent loads when they fit. */
export function SkillsPanel({ skills, set }: { skills: SkillRow[] | null; set: (s: SkillRow[]) => void }) {
  const t = useT()
  const { act } = useAct()
  const [open, setOpen] = useState<SkillRow | null>(null)
  const [creating, setCreating] = useState(false)
  if (!skills) return <p className="muted pad">{t('loading')}</p>
  return (
    <div>
      <div className="lede-row">
        <p className="lede">{t('s_sub')}</p>
        <Button icon="plus" onClick={() => setCreating(true)}>
          {t('s_new')}
        </Button>
      </div>
      <ul className="rows">
        {skills.map((s) => (
          <li key={s.name} className={`rowitem${s.enabled ? '' : ' is-off'}`}>
            <div className="rowitem-main">
              <div className="rowitem-title">
                <strong className="mono" dir="ltr">{s.name}</strong>
                <Badge tone={s.source === 'builtin' ? 'muted' : s.source === 'project' ? 'accent' : 'brand'}>{t(`s_src_${s.source}` as 's_src_user')}</Badge>
              </div>
              <span className="muted" dir="auto">{s.description}</span>
            </div>
            <Button small kind="ghost" onClick={() => setOpen(s)}>
              {s.editable ? t('edit') : t('s_view')}
            </Button>
            <Switch checked={s.enabled} onChange={(v) => void act('toggle', () => api<SkillRow[]>('PATCH', `${BASE}/${encodeURIComponent(s.name)}`, { enabled: v })).then((r) => r && set(r))} label={<span className="sr-only">{s.name}</span>} />
          </li>
        ))}
      </ul>
      {open ? <Editor skill={open} onClose={() => setOpen(null)} onSaved={set} /> : null}
      {creating ? (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={(list, name) => {
            set(list)
            setOpen(list.find((s) => s.name === name) ?? null)
          }}
        />
      ) : null}
    </div>
  )
}
