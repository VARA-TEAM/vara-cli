import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useT } from '../i18n'
import { Button } from './ui'

interface PreviewInfo {
  state: 'starting' | 'running' | 'stopped' | 'failed'
  url?: string
  command: string
  error?: string
}
interface PreviewState {
  preview: PreviewInfo | null
  logs: string
}

/**
 * The running app, inside the session. The page is served by VARA's own loopback proxy on a separate
 * port (a separate origin), and framed with a sandbox: scripts, forms and popups work, but it cannot
 * navigate this page away, and it never sees VARA's token. Owner only; guests never get a preview.
 */
export function Preview({ sessionId }: { sessionId: string }) {
  const t = useT()
  const [state, setState] = useState<PreviewState>({ preview: null, logs: '' })
  const [command, setCommand] = useState('npm run dev')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showLogs, setShowLogs] = useState(false)
  const [nonce, setNonce] = useState(0)
  const alive = useRef(true)

  const load = (): void => {
    api<PreviewState>('GET', `/api/sessions/${encodeURIComponent(sessionId)}/preview`)
      .then((s) => alive.current && setState(s))
      .catch(() => undefined)
  }
  useEffect(() => {
    alive.current = true
    load()
    const id = setInterval(load, 2500)
    return () => {
      alive.current = false
      clearInterval(id)
    }
  }, [sessionId])

  const start = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setState(await api<PreviewState>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/preview`, { command }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const stop = async (): Promise<void> => {
    setBusy(true)
    try {
      await api('DELETE', `/api/sessions/${encodeURIComponent(sessionId)}/preview`)
      setState({ preview: null, logs: '' })
    } finally {
      setBusy(false)
    }
  }

  const p = state.preview
  const running = p?.state === 'running' && p.url
  return (
    <section className="preview">
      {running ? (
        <>
          <div className="preview-bar">
            <span className="chip ok" dir="ltr">
              {p.url}
            </span>
            <Button small kind="ghost" onClick={() => setNonce((n) => n + 1)}>
              {t('pv_reload')}
            </Button>
            <a className="btn btn-ghost btn-sm" href={p.url} target="_blank" rel="noreferrer noopener">
              {t('pv_open')}
            </a>
            <Button small kind="danger" disabled={busy} onClick={() => void stop()}>
              {t('pv_stop')}
            </Button>
          </div>
          <iframe
            key={nonce}
            className="preview-frame"
            src={p.url}
            title={t('pv_title')}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            referrerPolicy="no-referrer"
          />
        </>
      ) : (
        <div className="preview-start">
          <p className="muted small">{p?.state === 'starting' ? t('pv_starting') : t('pv_hint')}</p>
          <input value={command} onChange={(e) => setCommand(e.target.value)} dir="ltr" aria-label={t('pv_command')} spellCheck={false} onKeyDown={(e) => e.key === 'Enter' && !busy && void start()} />
          <Button kind="primary" disabled={busy || !command.trim() || p?.state === 'starting'} onClick={() => void start()}>
            {busy || p?.state === 'starting' ? t('pv_starting') : t('pv_start')}
          </Button>
          {p?.state === 'failed' || p?.state === 'stopped' ? <p className="inline-error">{p.error ?? t('pv_stopped')}</p> : null}
        </div>
      )}
      {error ? <p className="inline-error">{error}</p> : null}
      {p ? (
        <>
          <button className="linklike" onClick={() => setShowLogs((v) => !v)}>
            {showLogs ? t('pv_hideLogs') : t('pv_logs')}
          </button>
          {showLogs ? (
            <pre className="preview-logs" dir="ltr">
              {state.logs || '…'}
            </pre>
          ) : null}
        </>
      ) : null}
    </section>
  )
}
