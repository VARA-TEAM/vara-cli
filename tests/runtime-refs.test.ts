import { describe, expect, it, beforeAll } from 'vitest'

// All modules are imported DYNAMICALLY and shared across the whole file: vitest
// isolates static vs dynamic import graphs, and these tests depend on the schema
// and the runtime reading the SAME module instance.
let ConfigSchema: typeof import('../src/config/config.js')
let runtime: typeof import('../src/runtime.js')
let refs: typeof import('../src/config/refs.js')

beforeAll(async () => {
  ConfigSchema = await import('../src/config/config.js')
  runtime = await import('../src/runtime.js')
  refs = await import('../src/config/refs.js')
  // Deterministic "no key" resolution: setup.ts already isolates VARA_HOME to a
  // temp dir (empty vault), but a KTAI_API_KEY in the running shell would still
  // be found via the env fallback. Clear it so the miss-path is guaranteed.
  delete process.env['KTAI_API_KEY']
  delete process.env['OPENAI_API_KEY']
})

/** A realistic VaraConfig with the provider block overridable per test. */
function makeConfig(provider: Record<string, unknown>) {
  return {
    provider: {
      id: 'openai',
      baseUrl: '',
      apiKeySecret: 'OPENAI_API_KEY',
      apiKeyEnv: 'OPENAI_API_KEY',
      model: 'gpt-4o',
      ...provider,
    },
  } as Parameters<typeof runtime.buildProvider>[0]
}

describe('config refs are NAMES, never key values', () => {
  it('accepts empty (unset) and normal variable names', () => {
    for (const good of ['', 'KTAI_API_KEY', 'OPENAI_API_KEY', 'my-provider.key-1']) {
      expect(refs.configRef(good)).toBe(true)
    }
  })

  it('rejects values that look like real keys or secrets', () => {
    for (const bad of [
      'sk-abc123',
      'sk-abcdefghijklmnopqrstuvwxyz',
      'ghp_abcdefghijklmnop1234567890',
      'Bearer abcdefghijklmnop',
      'AKIA1234567890ABCDEF',
      'my secret value',
      'key with spaces',
    ]) {
      expect(refs.configRef(bad)).toBe(false)
    }
  })

  it('ConfigSchema rejects a provider.apiKeySecret holding a real key', () => {
    const parsed = ConfigSchema.ProviderSchema.safeParse({
      id: 'openai',
      baseUrl: '',
      apiKeySecret: 'sk-abcdefghijklmnopqrstuvwxyz',
      apiKeyEnv: 'OPENAI_API_KEY',
      model: 'gpt-4o',
    })
    expect(parsed.success).toBe(false)
  })

  it('ConfigSchema rejects a provider.apiKeyEnv holding a real key', () => {
    const parsed = ConfigSchema.ProviderSchema.safeParse({
      id: 'openai',
      baseUrl: '',
      apiKeySecret: 'OPENAI_API_KEY',
      apiKeyEnv: 'sk-abcdefghijklmnopqrstuvwxyz',
      model: 'gpt-4o',
    })
    expect(parsed.success).toBe(false)
  })

  it('ConfigSchema accepts normal names (no false positives)', () => {
    const parsed = ConfigSchema.ProviderSchema.safeParse({
      id: 'openai',
      baseUrl: '',
      apiKeySecret: 'KTAI_API_KEY',
      apiKeyEnv: 'KTAI_API_KEY',
      model: 'deepseek-v4.1-flash',
    })
    expect(parsed.success).toBe(true)
  })
})

describe('buildProvider error never leaks a key', () => {
  it('throws a scrubbed message when no key is resolvable', async () => {
    // Point both lookups at a name that resolves to nothing.
    const cfg = makeConfig({ apiKeySecret: 'NO_SUCH_SECRET', apiKeyEnv: 'NO_SUCH_ENV_VAR_XYZ' })
    await expect(runtime.buildProvider(cfg)).rejects.toThrow(/No API key found/)
  })

  it('the "No API key" message contains the NAMES to set, verbatim', async () => {
    // Names absent from both the isolated vault and the shell env.
    const cfg = makeConfig({ apiKeySecret: 'VARA_TEST_ABSENT_SECRET', apiKeyEnv: 'VARA_TEST_ABSENT_ENV' })
    const err = await runtime.buildProvider(cfg).catch((e: unknown) => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('vara secret set VARA_TEST_ABSENT_SECRET')
    expect((err as Error).message).toContain('export VARA_TEST_ABSENT_ENV')
  })

  it('refuses to build when apiKeySecret holds a pasted key, and never echoes it', async () => {
    const PASTED = 'sk-abcdefghijklmnopqrstuvwxyz123456'
    const cfg = makeConfig({ apiKeySecret: PASTED, apiKeyEnv: '' })
    const err = await runtime.buildProvider(cfg).catch((e: unknown) => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toContain(PASTED)
    expect((err as Error).message).toMatch(/provider\.apiKeySecret/)
  })

  it('refuses to build when apiKeyEnv holds a pasted key, and never echoes it', async () => {
    const PASTED = 'sk-abcdefghijklmnopqrstuvwxyz123456'
    const cfg = makeConfig({ apiKeySecret: '', apiKeyEnv: PASTED })
    const err = await runtime.buildProvider(cfg).catch((e: unknown) => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toContain(PASTED)
    expect((err as Error).message).toMatch(/provider\.apiKeyEnv/)
  })

  it('assertConfigRef names the offending field', () => {
    expect(() => refs.assertConfigRef('provider.apiKeySecret', 'sk-abc')).toThrow(/provider\.apiKeySecret/)
    expect(() => refs.assertConfigRef('provider.apiKeyEnv', 'ok_name')).not.toThrow()
  })
})
