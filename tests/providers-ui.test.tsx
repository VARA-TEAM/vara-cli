import React from 'react'
import { render, cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type VaraConfig } from '../src/config/config.js'
import { ensureProviders } from '../src/config/providers.js'
import { ProviderManager, type ManagerDeps } from '../src/tui/providers.js'

afterEach(() => cleanup())

const savedKeys: Array<[string, string]> = []
const deps = (over: Partial<ManagerDeps> = {}): Partial<ManagerDeps> => ({
  discover: async () => [{ id: 'good-model', contextWindow: 32_000 }, { id: 'bad-model' }],
  check: async (_ep, model) =>
    model === 'good-model'
      ? { status: 'ok', detail: 'answered in 5ms', latencyMs: 5 }
      : { status: 'fail', detail: 'HTTP 404 model not found', latencyMs: 5 },
  endpoint: async (e) => ({ type: e.type, baseUrl: e.baseUrl, apiKey: 'k' }),
  saveKey: async (n, v) => void savedKeys.push([n, v]),
  keyState: async () => 'vault',
  ...over,
})

const cfg: VaraConfig = ensureProviders({ ...DEFAULT_CONFIG })
const settle = () => new Promise((r) => setTimeout(r, 60))

async function mount(props: Partial<React.ComponentProps<typeof ProviderManager>> = {}) {
  const onChange = vi.fn()
  const onUse = vi.fn()
  const onClose = vi.fn()
  const inst = render(<ProviderManager config={cfg} deps={deps()} onChange={onChange} onUse={onUse} onClose={onClose} {...props} />)
  await settle() // let ink attach stdin
  return { ...inst, onChange, onUse, onClose }
}

describe('ProviderManager', () => {
  it('lists configured providers and the built-in ones to add', async () => {
    const { lastFrame, unmount } = await mount()
    const f = lastFrame()!
    expect(f).toContain('Providers')
    expect(f).toContain('in use (gpt-4o)')
    expect(f).toContain('+ Anthropic')
    expect(f).toContain('+ Custom provider')
    unmount()
  })

  it('adds a preset: key (masked) → models fetched → status tested → use', async () => {
    const { lastFrame, stdin, onChange, onUse, unmount } = await mount()
    // Rows: openai, Custom provider, then presets — Anthropic is the third.
    stdin.write('\u001B[B')
    await settle()
    stdin.write('\u001B[B')
    await settle()
    stdin.write('\r')
    await vi.waitFor(() => expect(lastFrame()).toContain('API key'))
    stdin.write('sk-ant-secret-value')
    await vi.waitFor(() => expect(lastFrame()).toContain('•••'))
    expect(lastFrame()).not.toContain('sk-ant-secret-value')
    stdin.write('\r')
    await vi.waitFor(() => expect(lastFrame()).toContain('Models'))
    await vi.waitFor(() => expect(lastFrame()).toContain('good-model'))
    expect(savedKeys).toContainEqual(['ANTHROPIC_API_KEY', 'sk-ant-secret-value'])
    expect(lastFrame()).toContain('ctx 32k')

    stdin.write('a') // test all
    await vi.waitFor(() => expect(onChange.mock.calls.at(-1)![0].providers.anthropic.models['bad-model'].status).toBe('fail'))
    expect(onChange.mock.calls.at(-1)![0].providers.anthropic.models['good-model'].status).toBe('ok')

    // Sorted: bad-model, good-model — pick the second.
    await settle()
    stdin.write('\u001B[B')
    await settle()
    stdin.write('\r')
    await vi.waitFor(() => expect(onUse).toHaveBeenCalled())
    expect(onUse.mock.calls[0]![0].provider).toMatchObject({ name: 'anthropic', id: 'anthropic', model: 'good-model' })
    unmount()
  })

  it('edits a model context window by hand', async () => {
    const { lastFrame, stdin, onChange, unmount } = await mount({ initial: 'models' })
    expect(lastFrame()).toContain('gpt-4o')
    stdin.write('c')
    await vi.waitFor(() => expect(lastFrame()).toContain('Context window in tokens'))
    stdin.write('64k')
    await settle()
    stdin.write('\r')
    await vi.waitFor(() => expect(lastFrame()).toContain('Output reserve'))
    stdin.write('\r') // empty → automatic
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(onChange.mock.calls.at(-1)![0].providers.openai.models['gpt-4o']).toMatchObject({ contextWindow: 64_000, contextSource: 'manual' })
    await vi.waitFor(() => expect(lastFrame()).toContain('ctx 64k'))
    expect(lastFrame()).toContain('manual')
    unmount()
  })

  it('shows a provider failure instead of crashing', async () => {
    const { lastFrame, stdin, unmount } = await mount({
      initial: 'models',
      deps: deps({
        discover: async () => {
          throw new Error('Could not reach https://x: ECONNREFUSED')
        },
      }),
    })
    stdin.write('r')
    await vi.waitFor(() => expect(lastFrame()).toContain('ECONNREFUSED'))
    unmount()
  })

  it('Esc goes back one screen, then closes', async () => {
    const { lastFrame, stdin, onClose, unmount } = await mount()
    stdin.write('\r') // open openai
    await vi.waitFor(() => expect(lastFrame()).toContain('Models'))
    stdin.write('\u001B')
    await vi.waitFor(() => expect(lastFrame()).toContain('Providers'))
    expect(onClose).not.toHaveBeenCalled()
    await settle()
    stdin.write('\u001B')
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
    unmount()
  })

  it('adds a custom provider and fetches all its models', async () => {
    const { lastFrame, stdin, onChange, unmount } = await mount()
    stdin.write('\u001B[B') // Custom provider sits right under the configured ones
    await settle()
    stdin.write('\r')
    await vi.waitFor(() => expect(lastFrame()).toContain('Provider name'))
    stdin.write('my-llm')
    await settle()
    stdin.write('\r')
    await vi.waitFor(() => expect(lastFrame()).toContain('Protocol'))
    stdin.write('\r')
    await vi.waitFor(() => expect(lastFrame()).toContain('Base URL'))
    stdin.write('https://llm.test/v1')
    await settle()
    stdin.write('\r')
    await vi.waitFor(() => expect(lastFrame()).toContain('API key (leave empty'))
    stdin.write('\r') // no key → keyless local server
    await vi.waitFor(() => expect(lastFrame()).toContain('Enter fetches ALL'))
    stdin.write('\r')
    await vi.waitFor(() => expect(lastFrame()).toContain('good-model'))
    const last = onChange.mock.calls.at(-1)![0]
    expect(last.providers['my-llm']).toMatchObject({ keyless: true, baseUrl: 'https://llm.test/v1' })
    unmount()
  })
})
