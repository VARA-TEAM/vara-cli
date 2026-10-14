import { useCallback, useEffect, useRef, useState } from 'react'
import { api, streamEvents } from './api'
import type { HostEvent, Me, SessionSummary, SessionView } from './types'

export function useMe(authed: boolean): { me: Me | null; error: string | null; reload: () => void } {
  const [me, setMe] = useState<Me | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!authed) {
      setMe(null)
      return
    }
    let live = true
    api<Me>('GET', '/api/me')
      .then((m) => live && (setMe(m), setError(null)))
      .catch((e: Error) => live && setError(e.message))
    return () => {
      live = false
    }
  }, [authed, tick])
  return { me, error, reload: () => setTick((t) => t + 1) }
}

/** The session list, refreshed every few seconds and on demand. */
export function useSessions(enabled: boolean): { sessions: SessionSummary[]; reload: () => void; loaded: boolean } {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loaded, setLoaded] = useState(false)
  const reload = useCallback(() => {
    api<SessionSummary[]>('GET', '/api/sessions')
      .then((s) => {
        setSessions(s)
        setLoaded(true)
      })
      .catch(() => {})
  }, [])
  useEffect(() => {
    if (!enabled) return
    reload()
    const id = setInterval(reload, 4000)
    return () => clearInterval(id)
  }, [enabled, reload])
  return { sessions, reload, loaded }
}

export interface SubagentRow {
  id: string
  title: string
  status: 'running' | 'done' | 'failed'
  detail?: string
}

export interface LiveSession {
  view: SessionView | null
  /** Text the model is writing right now (not yet in the saved transcript). */
  stream: string
  /** The model's private reasoning stream (owner only; the host never sends it to guests). */
  thinking: string
  activeTool: string | null
  subagents: SubagentRow[]
  connected: boolean
  error: string | null
  reload: () => void
}

/** Events that mean the saved transcript changed: refetch it (debounced). */
const REFRESH_ON = new Set(['state', 'tool_start', 'tool_end', 'intent', 'completed', 'session_summary', 'message', 'followup_applied', 'subagent', 'error', 'verification', 'waiting', 'budget_warning', 'budget_exhausted'])

/**
 * One session, kept fresh: a snapshot from the host, plus its live event stream. The text the
 * model is writing is shown from `stream` until the next non-text event, when the snapshot
 * (which then contains it) takes over — so nothing is duplicated and nothing flickers.
 */
export function useLiveSession(id: string | null): LiveSession {
  const [view, setView] = useState<SessionView | null>(null)
  const [stream, setStream] = useState('')
  const [thinking, setThinking] = useState('')
  const [activeTool, setActiveTool] = useState<string | null>(null)
  const [subagents, setSubagents] = useState<SubagentRow[]>([])
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sealed = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const idRef = useRef(id)
  idRef.current = id

  const load = useCallback(() => {
    const current = idRef.current
    if (!current) return
    api<SessionView>('GET', `/api/sessions/${encodeURIComponent(current)}`)
      .then((v) => {
        if (idRef.current !== current) return
        setView(v)
        setError(null)
        if (sealed.current) {
          setStream('')
          setThinking('')
        }
      })
      .catch((e: Error) => idRef.current === current && setError(e.message))
  }, [])

  const schedule = useCallback(() => {
    if (timer.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      load()
    }, 140)
  }, [load])

  useEffect(() => {
    setView(null)
    setStream('')
    setThinking('')
    setActiveTool(null)
    setSubagents([])
    setError(null)
    sealed.current = false
    if (!id) return
    load()
    const stop = streamEvents(id, {
      onStatus: setConnected,
      onEvent: (e: HostEvent) => {
        if (e.type === 'text') {
          if (sealed.current) {
            sealed.current = false
            setStream(String(e['delta'] ?? ''))
          } else setStream((s) => s + String(e['delta'] ?? ''))
          return
        }
        if (e.type === 'thinking') {
          setThinking((t) => (t + String(e['text'] ?? '')).slice(-4000))
          return
        }
        if (e.type === 'tool_start') setActiveTool(String(e['name'] ?? ''))
        if (e.type === 'tool_end') setActiveTool(null)
        if (e.type === 'subagent') {
          const row: SubagentRow = { id: String(e['id']), title: String(e['title'] ?? ''), status: e['status'] as SubagentRow['status'], ...(e['detail'] ? { detail: String(e['detail']) } : {}) }
          setSubagents((rows) => (rows.some((r) => r.id === row.id) ? rows.map((r) => (r.id === row.id ? row : r)) : [...rows, row]))
        }
        if (e.type === 'state' && e['state'] === 'running') setSubagents([])
        if (e.type === 'revoked') setError('revoked')
        if (REFRESH_ON.has(e.type)) {
          sealed.current = true
          schedule()
        }
      },
    })
    return () => {
      stop()
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
    }
  }, [id, load, schedule])

  return { view, stream, thinking, activeTool, subagents, connected, error, reload: load }
}

/** Stick to the bottom while new content arrives, unless the reader scrolled up. */
export function useStickToBottom<T extends HTMLElement>(dep: unknown): { ref: React.RefObject<T>; atBottom: boolean; jump: () => void } {
  const ref = useRef<T>(null)
  const [atBottom, setAtBottom] = useState(true)
  const stick = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = (): void => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      stick.current = near
      setAtBottom(near)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [dep])
  return {
    ref,
    atBottom,
    jump: () => {
      const el = ref.current
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    },
  }
}

/** A GET that can be reloaded and replaced by a fresh server answer (after a change the server returns the new state). */
export function useResource<T>(path: string | null): { data: T | null; error: string | null; loading: boolean; reload: () => void; set: (v: T) => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(!!path)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!path) return
    let live = true
    setLoading(true)
    api<T>('GET', path)
      .then((v) => live && (setData(v), setError(null)))
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [path, tick])
  return { data, error, loading, reload: () => setTick((t) => t + 1), set: setData }
}
