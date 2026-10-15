import type { FoundModel } from '../config/providers.js'
import { scrubAll } from '../security/redact.js'

/**
 * Talking to a provider about its models: list them, and prove one works.
 * `fetch` is injectable so the whole module is testable offline.
 */

export interface Endpoint {
  type: 'openai' | 'anthropic'
  baseUrl: string
  apiKey: string
  flavor?: 'ollama'
}

type FetchFn = typeof fetch

export type CheckStatus = 'ok' | 'fail' | 'unknown'
export interface CheckResult {
  status: CheckStatus
  detail: string
  latencyMs: number
}

const LIST_TIMEOUT_MS = 15_000
const CHECK_TIMEOUT_MS = 25_000

function headers(ep: Endpoint): Record<string, string> {
  if (ep.type === 'anthropic') {
    return { 'x-api-key': ep.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
  }
  return { ...(ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {}), 'content-type': 'application/json' }
}

function base(ep: Endpoint): string {
  return ep.baseUrl.replace(/\/+$/, '')
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined
}

/** Providers report the window under many names; take the first that is a real number. */
function windowOf(m: Record<string, unknown>): number | undefined {
  const top = m['top_provider'] as Record<string, unknown> | undefined
  return (
    num(m['context_length']) ??
    num(m['context_window']) ??
    num(m['max_context_length']) ??
    num(m['max_model_len']) ??
    num(m['max_input_tokens']) ??
    num(m['inputTokenLimit']) ??
    num(top?.['context_length'])
  )
}

function outputOf(m: Record<string, unknown>): number | undefined {
  const top = m['top_provider'] as Record<string, unknown> | undefined
  return num(m['max_completion_tokens']) ?? num(m['max_output_tokens']) ?? num(m['max_tokens']) ?? num(top?.['max_completion_tokens'])
}

/** Pure parser (exported for tests): `/models` response body → models. */
export function parseModelList(body: unknown): FoundModel[] {
  const list = Array.isArray(body)
    ? body
    : Array.isArray((body as { data?: unknown })?.data)
      ? ((body as { data: unknown[] }).data)
      : Array.isArray((body as { models?: unknown })?.models)
        ? ((body as { models: unknown[] }).models)
        : []
  const out: FoundModel[] = []
  const seen = new Set<string>()
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const m = raw as Record<string, unknown>
    const idRaw = m['id'] ?? m['name']
    if (typeof idRaw !== 'string' || !idRaw) continue
    const id = idRaw.replace(/^models\//, '') // Gemini prefixes ids with "models/"
    if (seen.has(id)) continue
    seen.add(id)
    const contextWindow = windowOf(m)
    const maxOutputTokens = outputOf(m)
    const params = m['supported_parameters']
    const reasoning = Array.isArray(params) ? params.includes('reasoning') || params.includes('include_reasoning') : undefined
    const arch = m['architecture']
    const modalities = arch && typeof arch === 'object' ? (arch as Record<string, unknown>)['input_modalities'] : undefined
    const vision = Array.isArray(modalities) ? modalities.includes('image') : undefined
    out.push({ id, ...(contextWindow ? { contextWindow } : {}), ...(maxOutputTokens ? { maxOutputTokens } : {}), ...(reasoning !== undefined ? { reasoning } : {}), ...(vision !== undefined ? { vision } : {}) })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

function explain(status: number, body: string): string {
  const snippet = scrubAll(body.replace(/\s+/g, ' ').slice(0, 160))
  const hint =
    status === 401 || status === 403
      ? 'invalid or unauthorized API key'
      : status === 404
        ? 'not found (wrong base URL or model id)'
        : status === 429
          ? 'rate limited'
          : `HTTP ${status}`
  return snippet ? `${hint} — ${snippet}` : hint
}

/** Fetch every model the provider offers. Throws a readable error on failure. */
export async function discoverModels(ep: Endpoint, fetchFn: FetchFn = fetch): Promise<FoundModel[]> {
  const url = ep.type === 'anthropic' ? `${base(ep)}/v1/models?limit=1000` : `${base(ep)}/models`
  let res: Response
  try {
    res = await fetchFn(url, { headers: headers(ep), signal: AbortSignal.timeout(LIST_TIMEOUT_MS) })
  } catch (err) {
    throw new Error(`Could not reach ${base(ep)}: ${scrubAll((err as Error).message)}`)
  }
  const text = await res.text()
  if (!res.ok) throw new Error(`Model list failed: ${explain(res.status, text)}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('The provider did not return JSON from its model list.')
  }
  const models = parseModelList(parsed)
  if (ep.flavor === 'ollama') await enrichOllama(ep, models, fetchFn)
  return models
}

/**
 * Ollama's /v1/models carries no window; its native /api/show does. Best
 * effort and bounded: failures just leave the window to automatic detection.
 */
async function enrichOllama(ep: Endpoint, models: FoundModel[], fetchFn: FetchFn): Promise<void> {
  const root = base(ep).replace(/\/v1$/, '')
  await Promise.all(
    models.slice(0, 40).map(async (m) => {
      try {
        const res = await fetchFn(`${root}/api/show`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: m.id }),
          signal: AbortSignal.timeout(5_000),
        })
        if (!res.ok) return
        const info = ((await res.json()) as { model_info?: Record<string, unknown> }).model_info ?? {}
        const key = Object.keys(info).find((k) => k.endsWith('.context_length'))
        const win = key ? num(info[key]) : undefined
        if (win) m.contextWindow = win
      } catch {
        /* leave it to automatic detection */
      }
    }),
  )
}

/**
 * Prove a model works with one tiny real completion. Green only when the
 * provider actually answered; a rate limit is "unknown", not a failure — the
 * key and model were accepted, the quota is the problem.
 */
export async function checkModel(ep: Endpoint, model: string, fetchFn: FetchFn = fetch): Promise<CheckResult> {
  const started = Date.now()
  const attempt = async (tokenParam: 'max_tokens' | 'max_completion_tokens'): Promise<Response> => {
    const body =
      ep.type === 'anthropic'
        ? { model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with: ok' }] }
        : { model, [tokenParam]: 16, stream: false, messages: [{ role: 'user', content: 'Reply with: ok' }] }
    const url = ep.type === 'anthropic' ? `${base(ep)}/v1/messages` : `${base(ep)}/chat/completions`
    return fetchFn(url, { method: 'POST', headers: headers(ep), body: JSON.stringify(body), signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) })
  }
  try {
    let res = await attempt('max_tokens')
    let text = await res.text()
    // Newer OpenAI reasoning models reject `max_tokens`; retry with the new name.
    if (res.status === 400 && ep.type === 'openai' && /max_completion_tokens/i.test(text)) {
      res = await attempt('max_completion_tokens')
      text = await res.text()
    }
    const latencyMs = Date.now() - started
    if (res.ok) return { status: 'ok', detail: `answered in ${latencyMs}ms`, latencyMs }
    if (res.status === 429) return { status: 'unknown', detail: explain(res.status, text), latencyMs }
    return { status: 'fail', detail: explain(res.status, text), latencyMs }
  } catch (err) {
    const msg = (err as Error).name === 'TimeoutError' ? 'timed out' : scrubAll((err as Error).message)
    return { status: 'fail', detail: msg, latencyMs: Date.now() - started }
  }
}

/** Run `fn` over items with bounded concurrency; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
