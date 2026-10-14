import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import {
  activate,
  addCustomProvider,
  addModel,
  addProviderFromPreset,
  contextOrigin,
  contextSettingsFor,
  ensureProviders,
  mergeDiscovered,
  removeModel,
  removeProvider,
  setModelContext,
  setModelStatus,
} from '../src/config/providers.js'
import { findPreset } from '../src/llm/presets.js'
import { parseModelList, checkModel, discoverModels, mapLimit } from '../src/llm/discovery.js'
import { parseTokens, windowStart } from '../src/tui/providers.js'
import { resolveWindow } from '../src/core/context.js'

const base = ensureProviders(DEFAULT_CONFIG)

describe('multi-provider config', () => {
  it('lifts a legacy single-provider config into providers', () => {
    expect(base.providers['openai']?.models['gpt-4o']).toBeDefined()
    expect(base.provider.name).toBe('openai')
    expect(ensureProviders(base)).toEqual(base) // idempotent
  })

  it('adds a preset, then activating copies it into the active provider block', () => {
    let c = addProviderFromPreset(base, findPreset('deepseek')!)
    expect(Object.keys(c.providers['deepseek']!.models)).toContain('deepseek-chat')
    expect(c.providers['deepseek']!.apiKeySecret).toBe('DEEPSEEK_API_KEY')
    c = activate(c, 'deepseek', 'deepseek-chat')
    expect(c.provider).toMatchObject({ id: 'openai', name: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' })
    // The original config is never mutated.
    expect(base.provider.name).toBe('openai')
  })

  it('keyless local presets need no secret', () => {
    const c = addProviderFromPreset(base, findPreset('ollama')!)
    expect(c.providers['ollama']).toMatchObject({ keyless: true, apiKeySecret: '', flavor: 'ollama' })
  })

  it('custom providers are validated', () => {
    const c = addCustomProvider(base, { name: 'my-llm', type: 'openai', baseUrl: 'https://x.test/v1/', models: ['a', 'b'] })
    expect(c.providers['my-llm']!.baseUrl).toBe('https://x.test/v1')
    expect(Object.keys(c.providers['my-llm']!.models)).toEqual(['a', 'b'])
    expect(c.providers['my-llm']!.apiKeySecret).toBe('MY_LLM_API_KEY')
    expect(() => addCustomProvider(c, { name: 'my-llm', type: 'openai', baseUrl: 'https://x.test' })).toThrow(/already exists/)
    expect(() => addCustomProvider(base, { name: 'Bad Name', type: 'openai', baseUrl: 'https://x.test' })).toThrow(/lowercase/)
    expect(() => addCustomProvider(base, { name: 'ok', type: 'openai', baseUrl: 'ftp://x' })).toThrow(/http/)
  })

  it('refuses to remove the provider or model in use', () => {
    expect(() => removeProvider(base, 'openai')).toThrow(/in use/)
    expect(() => removeModel(base, 'openai', 'gpt-4o')).toThrow(/in use/)
    const c = addModel(base, 'openai', 'gpt-4o-mini')
    expect(Object.keys(removeModel(c, 'openai', 'gpt-4o-mini').providers['openai']!.models)).toEqual(['gpt-4o'])
  })

  it('records per-model health', () => {
    const c = setModelStatus(addModel(base, 'openai', 'x'), 'openai', 'x', 'fail', 'HTTP 404')
    expect(c.providers['openai']!.models['x']).toMatchObject({ status: 'fail', statusDetail: 'HTTP 404' })
  })
})

describe('smart context configuration', () => {
  it('discovery fills the window but never overrides a manual value', () => {
    let c = mergeDiscovered(base, 'openai', [{ id: 'gpt-4o', contextWindow: 111_000 }, { id: 'new', contextWindow: 32_000 }])
    expect(contextOrigin(c, 'openai', 'new')).toEqual({ windowTokens: 32_000, origin: 'api' })
    c = setModelContext(c, 'openai', 'new', { contextWindow: 50_000 })
    expect(contextOrigin(c, 'openai', 'new')).toEqual({ windowTokens: 50_000, origin: 'manual' })
    c = mergeDiscovered(c, 'openai', [{ id: 'new', contextWindow: 99_000 }])
    expect(contextOrigin(c, 'openai', 'new').windowTokens).toBe(50_000)
    // Clearing returns to automatic.
    c = setModelContext(c, 'openai', 'new', { contextWindow: null })
    expect(c.providers['openai']!.models['new']!.contextWindow).toBeUndefined()
  })

  it('a refresh drops seeded models the provider does not offer, but keeps tested/manual/in-use ones', () => {
    let c = addProviderFromPreset(base, findPreset('deepseek')!) // seeds deepseek-chat + deepseek-reasoner
    c = setModelStatus(c, 'deepseek', 'deepseek-reasoner', 'ok')
    c = mergeDiscovered(c, 'deepseek', [{ id: 'other' }])
    expect(Object.keys(c.providers['deepseek']!.models).sort()).toEqual(['deepseek-reasoner', 'other'])
    // The model in use survives even if the provider stopped listing it.
    const d = mergeDiscovered(base, 'openai', [{ id: 'x' }])
    expect(Object.keys(d.providers['openai']!.models).sort()).toEqual(['gpt-4o', 'x'])
  })

  it('falls back: known pattern, then a marked assumption', () => {
    expect(contextOrigin(base, 'openai', 'gpt-4o').origin).toBe('known')
    expect(contextOrigin(base, 'openai', 'totally-unknown-model').origin).toBe('assumed')
  })

  it('feeds the engine: discovered window reads as detected, manual as configured', () => {
    let c = mergeDiscovered(base, 'openai', [{ id: 'gpt-4o', contextWindow: 20_000 }])
    const s1 = contextSettingsFor(c, 'gpt-4o')
    expect(resolveWindow('gpt-4o', s1)).toEqual({ windowTokens: 20_000, source: 'detected' })
    c = setModelContext(c, 'openai', 'gpt-4o', { contextWindow: 30_000, maxOutputTokens: 2_000 })
    const s2 = contextSettingsFor(c, 'gpt-4o')
    expect(resolveWindow('gpt-4o', s2).source).toBe('configured')
    expect(s2.maxOutputTokens).toBe(2_000)
  })

  it('clamps the output reserve so a tiny local window keeps room for input', () => {
    const c = mergeDiscovered(base, 'openai', [{ id: 'tiny', contextWindow: 2_048 }])
    expect(contextSettingsFor(c, 'tiny').maxOutputTokens).toBe(512)
  })

  it('parses human token values', () => {
    expect(parseTokens('128k')).toBe(128_000)
    expect(parseTokens('1m')).toBe(1_000_000)
    expect(parseTokens('200,000')).toBe(200_000)
    expect(parseTokens('')).toBeNull()
    expect(parseTokens('abc')).toBeUndefined()
    expect(parseTokens('10')).toBeUndefined()
  })

  it('windowStart keeps the selection visible', () => {
    expect(windowStart(0, 5, 3)).toBe(0)
    expect(windowStart(50, 5, 100)).toBe(48)
    expect(windowStart(99, 5, 100)).toBe(95)
  })
})

describe('provider discovery', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

  it('parses OpenAI, OpenRouter, Gemini and Anthropic style lists', () => {
    expect(parseModelList({ data: [{ id: 'b' }, { id: 'a', context_length: 8192 }, { id: 'a' }] })).toEqual([
      { id: 'a', contextWindow: 8192 },
      { id: 'b' },
    ])
    expect(parseModelList({ data: [{ id: 'x', top_provider: { context_length: 1000, max_completion_tokens: 200 } }] })[0]).toEqual({
      id: 'x',
      contextWindow: 1000,
      maxOutputTokens: 200,
    })
    expect(parseModelList({ data: [{ id: 'models/gemini-2.5-flash' }] })[0]!.id).toBe('gemini-2.5-flash')
    expect(parseModelList({ data: [{ id: 'claude-x', max_input_tokens: 200000, max_tokens: 64000 }] })[0]).toMatchObject({ contextWindow: 200000, maxOutputTokens: 64000 })
    expect(parseModelList('garbage')).toEqual([])
  })

  it('discovers with the right URL and auth per protocol', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> })
      return json({ data: [{ id: 'm1' }] })
    }) as unknown as typeof fetch
    await discoverModels({ type: 'openai', baseUrl: 'https://h/v1/', apiKey: 'k' }, f)
    await discoverModels({ type: 'anthropic', baseUrl: 'https://a', apiKey: 'k' }, f)
    expect(seen[0]).toMatchObject({ url: 'https://h/v1/models', headers: { authorization: 'Bearer k' } })
    expect(seen[1]!.url).toBe('https://a/v1/models?limit=1000')
    expect(seen[1]!.headers['x-api-key']).toBe('k')
  })

  it('reports an unusable provider with a readable error', async () => {
    const f = (async () => json({ error: 'nope' }, 401)) as unknown as typeof fetch
    await expect(discoverModels({ type: 'openai', baseUrl: 'https://h', apiKey: 'k' }, f)).rejects.toThrow(/invalid or unauthorized API key/)
  })

  it('checkModel: green only on a real answer; 404 red; 429 unknown', async () => {
    const mk = (status: number) => (async () => json({ ok: 1 }, status)) as unknown as typeof fetch
    const ep = { type: 'openai' as const, baseUrl: 'https://h', apiKey: 'k' }
    expect((await checkModel(ep, 'm', mk(200))).status).toBe('ok')
    expect((await checkModel(ep, 'm', mk(404))).status).toBe('fail')
    expect((await checkModel(ep, 'm', mk(401))).detail).toMatch(/API key/)
    expect((await checkModel(ep, 'm', mk(429))).status).toBe('unknown')
    const boom = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    expect((await checkModel(ep, 'm', boom)).status).toBe('fail')
  })

  it('checkModel retries with max_completion_tokens when the model demands it', async () => {
    const bodies: string[] = []
    const f = (async (_u: string, init: RequestInit) => {
      bodies.push(String(init.body))
      return bodies.length === 1 ? json({ error: { message: "use 'max_completion_tokens'" } }, 400) : json({ ok: 1 })
    }) as unknown as typeof fetch
    const r = await checkModel({ type: 'openai', baseUrl: 'https://h', apiKey: 'k' }, 'o3', f)
    expect(r.status).toBe('ok')
    expect(bodies[1]).toContain('max_completion_tokens')
  })

  it('mapLimit bounds concurrency and keeps order', async () => {
    let live = 0
    let peak = 0
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      live++
      peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 5))
      live--
      return n * 2
    })
    expect(out).toEqual([2, 4, 6, 8, 10, 12])
    expect(peak).toBeLessThanOrEqual(2)
  })
})
