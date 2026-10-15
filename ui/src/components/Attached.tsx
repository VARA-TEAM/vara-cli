import { useEffect, useState } from 'react'
import { auth } from '../api'

/**
 * An image attached to a message. The file is behind the session's access check, so it is fetched
 * with the token and shown from a blob URL (a plain <img src> cannot send the Authorization header).
 */
export function AttachedImage({ sessionId, file, name }: { sessionId: string; file: string; name: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let url: string | null = null
    let live = true
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(file)}`, { headers: { authorization: `Bearer ${auth.get()}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => {
        if (!live) return
        url = URL.createObjectURL(b)
        setSrc(url)
      })
      .catch(() => live && setFailed(true))
    return () => {
      live = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [sessionId, file])
  if (failed) return <span className="attached-missing">{name}</span>
  return src ? <img className="attached-img" src={src} alt={name} title={name} loading="lazy" /> : <span className="attached-img attached-loading" aria-hidden="true" />
}
