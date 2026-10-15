import type { HostEvent } from './types'

/**
 * Talks to the VARA host. The token lives in sessionStorage for the owner (gone when the
 * tab closes) and in localStorage for a guest (so a reload or a return visit keeps them in).
 * It is only ever sent as an Authorization header, never in a URL.
 */

const KEY = 'vara.token'
const KEY_KIND = 'vara.token.kind'

export const auth = {
  get(): string {
    try {
      return sessionStorage.getItem(KEY) ?? localStorage.getItem(KEY) ?? ''
    } catch {
      return memory
    }
  },
  set(token: string, where: 'session' | 'local'): void {
    memory = token
    try {
      sessionStorage.removeItem(KEY)
      localStorage.removeItem(KEY)
      ;(where === 'session' ? sessionStorage : localStorage).setItem(KEY, token)
      localStorage.setItem(KEY_KIND, where)
    } catch {
      /* private mode: keep it in memory for this tab */
    }
  },
  clear(): void {
    memory = ''
    try {
      sessionStorage.removeItem(KEY)
      localStorage.removeItem(KEY)
    } catch {
      /* nothing stored */
    }
  },
}
let memory = ''

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

const unauthorizedListeners = new Set<() => void>()
export const onUnauthorized = (fn: () => void): (() => void) => {
  unauthorizedListeners.add(fn)
  return () => unauthorizedListeners.delete(fn)
}

export interface UploadInfo {
  id: string
  name: string
  kind: 'image' | 'text'
  size: number
  note?: string
}

/** Send one file (raw bytes) to be attached to the next message. */
export async function uploadFile(file: File): Promise<UploadInfo> {
  const res = await fetch('/api/uploads', {
    method: 'POST',
    headers: { authorization: `Bearer ${auth.get()}`, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name || 'pasted-image') },
    body: file,
  })
  const data = (await res.json().catch(() => ({}))) as UploadInfo & { error?: string }
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`)
  return data
}

export async function api<T>(method: string, path: string, body?: unknown, opts: { anonymous?: boolean; signal?: AbortSignal } = {}): Promise<T> {
  const token = auth.get()
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token && !opts.anonymous ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  let data: unknown = null
  const text = await res.text()
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  if (!res.ok) {
    if (res.status === 401 && !opts.anonymous) for (const l of unauthorizedListeners) l()
    const msg = typeof data === 'object' && data && 'error' in data ? String((data as { error: unknown }).error) : `HTTP ${res.status}`
    throw new ApiError(res.status, msg)
  }
  return data as T
}

/** Parse Server-Sent-Event frames out of a growing text buffer. Exported for tests. */
export function parseSse(buffer: string): { frames: Array<{ id: number | null; data: string }>; rest: string } {
  const frames: Array<{ id: number | null; data: string }> = []
  let rest = buffer
  for (;;) {
    const end = rest.indexOf('\n\n')
    if (end < 0) break
    const block = rest.slice(0, end)
    rest = rest.slice(end + 2)
    let id: number | null = null
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) id = Number(line.slice(3).trim())
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (data.length) frames.push({ id: Number.isFinite(id) ? id : null, data: data.join('\n') })
  }
  return { frames, rest }
}

/**
 * Live events of one session. Uses fetch (not EventSource) so the token stays in a header.
 * Reconnects with backoff and resumes after the last event id. Returns a stop function.
 */
export function streamEvents(
  sessionId: string,
  handlers: { onEvent: (e: HostEvent) => void; onStatus: (connected: boolean) => void },
): () => void {
  let stopped = false
  let last = 0
  let controller: AbortController | null = null

  const run = async (): Promise<void> => {
    let delay = 500
    while (!stopped) {
      controller = new AbortController()
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events?after=${last}`, {
          headers: { authorization: `Bearer ${auth.get()}` },
          signal: controller.signal,
        })
        if (res.status === 401) {
          for (const l of unauthorizedListeners) l()
          return
        }
        if (!res.ok || !res.body) throw new ApiError(res.status, 'stream failed')
        handlers.onStatus(true)
        delay = 500
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          const { frames, rest } = parseSse(buf)
          buf = rest
          for (const f of frames) {
            if (f.id !== null) last = Math.max(last, f.id)
            try {
              const e = JSON.parse(f.data) as HostEvent
              handlers.onEvent(e)
              if (e.type === 'revoked') {
                stopped = true
                return
              }
            } catch {
              /* a malformed frame must not kill the stream */
            }
          }
        }
      } catch (err) {
        if (stopped) return
        if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
          handlers.onStatus(false)
          return
        }
      }
      handlers.onStatus(false)
      if (stopped) return
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 2, 8000)
    }
  }
  void run()
  return () => {
    stopped = true
    controller?.abort()
  }
}
