/**
 * A small Chrome DevTools Protocol client. No dependency: it uses the WebSocket built into Node 22+.
 * `Transport` is the seam the tests replace with a scripted fake.
 */
export interface Transport {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>
  on(event: string, handler: (params: Record<string, unknown>, sessionId?: string) => void): () => void
  close(): void
}

type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }

export function webSocketAvailable(): boolean {
  return typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function'
}

export async function connectCdp(wsUrl: string, timeoutMs = 15_000): Promise<Transport> {
  const WS = (globalThis as unknown as { WebSocket?: new (u: string) => WebSocketLike }).WebSocket
  if (!WS) throw new Error('the browser tools need Node.js 22 or newer (a built-in WebSocket); the VARA release packages include it')
  const ws = new WS(wsUrl)
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('could not connect to the browser')), timeoutMs)
    ws.onopen = () => (clearTimeout(t), resolve())
    ws.onerror = () => (clearTimeout(t), reject(new Error('could not connect to the browser')))
  })
  let next = 1
  const pending = new Map<number, Pending>()
  const handlers = new Map<string, Set<(p: Record<string, unknown>, s?: string) => void>>()
  ws.onmessage = (ev: { data: unknown }) => {
    let msg: { id?: number; result?: Record<string, unknown>; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string }
    try {
      msg = JSON.parse(String(ev.data))
    } catch {
      return
    }
    if (msg.id !== undefined) {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result ?? {})
    } else if (msg.method) {
      for (const h of handlers.get(msg.method) ?? []) h(msg.params ?? {}, msg.sessionId)
    }
  }
  ws.onclose = () => {
    for (const p of pending.values()) p.reject(new Error('the browser closed'))
    pending.clear()
  }
  return {
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const id = next++
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`${method} timed out`))
        }, 30_000)
      }),
    on: (event, handler) => {
      const set = handlers.get(event) ?? new Set()
      set.add(handler)
      handlers.set(event, set)
      return () => set.delete(handler)
    },
    close: () => {
      try {
        ws.close()
      } catch {
        /* already closed */
      }
    },
  }
}

interface WebSocketLike {
  onopen: (() => void) | null
  onerror: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: (() => void) | null
  send(data: string): void
  close(): void
}
