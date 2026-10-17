import { useState } from 'react'
import { ApiError, api, auth } from '../api'
import { useT } from '../i18n'
import { Button, Field } from './ui'
import { LogoMark } from './Logo'

/** Shown when the page is opened without a link that carries access. */
export function SignIn() {
  const t = useT()
  return (
    <div className="center-screen">
      <div className="card narrow">
        <div className="logo-mark" aria-hidden="true">
          <LogoMark size={56} />
        </div>
        <h1>{t('signin_title')}</h1>
        <p className="muted">{t('signin_body')}</p>
        <pre className="cmd" dir="ltr">vara ui</pre>
      </div>
    </div>
  )
}

/** /join/<token>: pick a name and enter. */
export function Join({ invite, onJoined }: { invite: string; onJoined: () => void }) {
  const t = useT()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ accessToken: string }>('POST', '/api/join', { invite, name: name.trim() || 'guest' }, { anonymous: true })
      auth.set(r.accessToken, 'local')
      history.replaceState(null, '', '/')
      onJoined()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('join_failed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="center-screen">
      <form
        className="card narrow"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="logo-mark" aria-hidden="true">
          <LogoMark size={56} />
        </div>
        <h1>{t('join_title')}</h1>
        <p className="muted">{t('join_body')}</p>
        <Field label={t('join_name')}>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoFocus dir="auto" autoComplete="nickname" />
        </Field>
        {error ? <div className="inline-error" role="alert">{error}</div> : null}
        <Button type="submit" kind="primary" disabled={busy}>
          {t('join_button')}
        </Button>
      </form>
    </div>
  )
}
