import { useEffect, useState } from 'react'
import { api } from '../api'
import { useT } from '../i18n'
import type { MemoryFile, MemoryState } from '../types'
import { useAct } from './toast'
import { Button, Field, Switch } from './ui'

const BASE = '/api/manage/memory'

/** One file of notes as one editable textarea (one note per line); saved whole, validated by the host. */
function Notes({ scope, file, set }: { scope: 'user' | 'project'; file: MemoryFile; set: (s: MemoryState) => void }) {
  const t = useT()
  const { busy, act } = useAct()
  const original = file.notes.join('\n')
  const [text, setText] = useState(original)
  useEffect(() => setText(original), [original])
  const dirty = text !== original
  const title = scope === 'user' ? t('mem_user') : t('mem_project')
  return (
    <section>
      <h3 className="sec">{title}</h3>
      <p className="muted mono" dir="ltr">{file.file}</p>
      <textarea className="code-edit" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} rows={7} aria-label={title} placeholder={t('mem_placeholder')} />
      <div className="dialog-foot">
        <Button
          kind="primary"
          disabled={!dirty || !!busy}
          onClick={() =>
            void act('save', () => api<MemoryState>('PUT', BASE, { scope, notes: text.split('\n').map((l) => l.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean) }), t('saved')).then((r) => r && set(r))
          }
        >
          {t('save')}
        </Button>
      </div>
    </section>
  )
}

/** Settings → Memory: the notes that survive between sessions, exactly as they are on disk. */
export function MemoryPanel({ state, set }: { state: MemoryState | null; set: (s: MemoryState) => void }) {
  const t = useT()
  const { act } = useAct()
  if (!state) return <p className="muted pad">{t('loading')}</p>
  const patch = (body: Record<string, unknown>) => void act('save', () => api<MemoryState>('PUT', BASE, body)).then((r) => r && set(r))
  return (
    <div>
      <p className="lede">{t('mem_sub', { tokens: state.maxTokens })}</p>
      <ul className="rows">
        <li className="rowitem">
          <div className="rowitem-main">
            <strong>{t('mem_enable')}</strong>
            <span className="muted">{t('mem_enableHelp')}</span>
          </div>
          <Switch checked={state.enabled} onChange={(v) => patch({ enabled: v })} label={<span className="sr-only">{t('mem_enable')}</span>} />
        </li>
      </ul>
      <Field label={t('mem_writes')} hint={t('mem_writesHelp')}>
        <select value={state.agentWrites} onChange={(e) => patch({ agentWrites: e.target.value })}>
          <option value="ask">{t('mem_w_ask')}</option>
          <option value="auto">{t('mem_w_auto')}</option>
          <option value="off">{t('mem_w_off')}</option>
        </select>
      </Field>
      <Field label={t('mem_budget')} hint={t('mem_budgetHelp')}>
        <input type="number" min={50} max={2000} step={50} defaultValue={state.maxTokens} key={state.maxTokens} onBlur={(e) => Number(e.target.value) !== state.maxTokens && patch({ maxTokens: Number(e.target.value) })} dir="ltr" />
      </Field>
      <Notes scope="project" file={state.project} set={set} />
      <Notes scope="user" file={state.user} set={set} />
    </div>
  )
}
