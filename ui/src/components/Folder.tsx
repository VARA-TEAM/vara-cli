import { useEffect, useState } from 'react'
import { api } from '../api'
import { useT } from '../i18n'
import { useAct } from './toast'
import { Button, Dialog, Icon } from './ui'

interface Browse {
  path: string
  parent: string | null
  dirs: string[]
}
export interface FolderInfo {
  current: string
  recent: string[]
}

const join = (base: string, name: string): string => `${base.replace(/[\\/]+$/, '')}${base.includes('\\') ? '\\' : '/'}${name}`

/** Choose the folder VARA works in: recent ones, or browse the machine and pick any folder. */
export function FolderDialog({ info, onClose, onChanged }: { info: FolderInfo; onClose: () => void; onChanged: (current: string) => void }) {
  const t = useT()
  const { busy, act } = useAct()
  const [view, setView] = useState<Browse | null>(null)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)

  const open = (path: string): void => {
    api<Browse>('GET', `/api/folder/browse?path=${encodeURIComponent(path)}`)
      .then((b) => (setView(b), setTyped(b.path), setError(null)))
      .catch((e: Error) => setError(e.message))
  }
  useEffect(() => open(info.current), [info.current])

  const choose = async (path: string): Promise<void> => {
    const r = await act('folder', () => api<{ current: string }>('POST', '/api/folder', { path }), t('f_changed'))
    if (r) (onChanged(r.current), onClose())
  }
  return (
    <Dialog title={t('f_title')} onClose={onClose} wide>
      <p className="muted">{t('f_help')}</p>
      {info.recent.length ? (
        <>
          <h3 className="sec first">{t('f_recent')}</h3>
          <ul className="rows">
            {info.recent.map((r) => (
              <li key={r} className="rowitem">
                <button className="link-btn mono clip" dir="ltr" onClick={() => void choose(r)}>
                  {r}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h3 className={`sec${info.recent.length ? '' : ' first'}`}>{t('f_browse')}</h3>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          open(typed)
        }}
      >
        <input value={typed} onChange={(e) => setTyped(e.target.value)} dir="ltr" aria-label={t('f_path')} className="mono" style={{ flex: 1 }} />
        <Button type="submit">{t('f_go')}</Button>
      </form>
      {error ? <div className="inline-error" role="alert">{error}</div> : null}
      {view ? (
        <ul className="folder-list" dir="ltr">
          {view.parent ? (
            <li>
              <button onClick={() => open(view.parent!)}>
                <Icon name="chevron" size={14} className="up" /> ..
              </button>
            </li>
          ) : null}
          {view.dirs.map((d) => (
            <li key={d}>
              <button onClick={() => open(join(view.path, d))}>
                <Icon name="file" size={14} /> {d}
              </button>
            </li>
          ))}
          {view.dirs.length === 0 ? <li className="muted pad">{t('f_empty')}</li> : null}
        </ul>
      ) : null}
      <div className="dialog-foot">
        <Button kind="ghost" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button kind="primary" disabled={!view || !!busy} onClick={() => view && void choose(view.path)}>
          {t('f_use')}
        </Button>
      </div>
    </Dialog>
  )
}
