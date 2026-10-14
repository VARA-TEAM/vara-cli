import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { VaraConfig, ProviderEntry } from '../config/config.js'
import {
  activate,
  activeProviderName,
  addCustomProvider,
  addModel,
  addProviderFromPreset,
  contextOrigin,
  mergeDiscovered,
  removeModel,
  removeProvider,
  secretNameFor,
  setModelContext,
  setModelStatus,
  setModelThinking,
  thinkingFor,
  validProviderName,
  type WindowOrigin,
} from '../config/providers.js'
import { PRESETS, type ProviderPreset } from '../llm/presets.js'
import { checkModel, discoverModels, mapLimit, type CheckResult, type Endpoint } from '../llm/discovery.js'
import type { FoundModel } from '../config/providers.js'
import { keySource, resolveApiKey } from '../runtime.js'
import { setSecret } from '../security/vault.js'
import { registerSecret, scrubAll } from '../security/redact.js'
import { formatTokens } from '../core/context.js'
import { nextLevel } from '../llm/capabilities.js'
import { glyph, theme } from './theme.js'

/** Everything the manager does outside React — injectable so it is testable offline. */
export interface ManagerDeps {
  discover(ep: Endpoint): Promise<FoundModel[]>
  check(ep: Endpoint, model: string): Promise<CheckResult>
  endpoint(entry: ProviderEntry): Promise<Endpoint>
  saveKey(secretName: string, value: string): Promise<void>
  keyState(entry: ProviderEntry): Promise<'vault' | 'env' | 'none' | 'not needed'>
}

export const defaultDeps: ManagerDeps = {
  discover: (ep) => discoverModels(ep),
  check: (ep, model) => checkModel(ep, model),
  endpoint: async (entry) => ({
    type: entry.type,
    baseUrl: entry.baseUrl,
    apiKey: await resolveApiKey(entry),
    ...(entry.flavor ? { flavor: entry.flavor } : {}),
  }),
  saveKey: async (name, value) => {
    await setSecret(name, value)
    registerSecret(value, name)
  },
  keyState: (entry) => keySource(entry),
}

/** "128k" / "1m" / "200000" → tokens. Empty → null (reset to automatic). */
export function parseTokens(text: string): number | null | undefined {
  const t = text.trim().toLowerCase().replace(/[,_\s]/g, '')
  if (!t) return null
  const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(t)
  if (!m) return undefined
  const n = Number(m[1]) * (m[2] === 'k' ? 1_000 : m[2] === 'm' ? 1_000_000 : 1)
  return Number.isFinite(n) && n >= 256 ? Math.round(n) : undefined
}

/** First index of a `size`-row window that keeps `selected` visible. */
export function windowStart(selected: number, size: number, total: number): number {
  if (total <= size) return 0
  return Math.max(0, Math.min(selected - Math.floor(size / 2), total - size))
}

/**
 * State whose latest value is readable synchronously. Two keystrokes can reach
 * the handler before React re-renders (a paste followed by Enter); reading the
 * ref keeps the second one from acting on stale state.
 */
export function useSync<T>(init: T): [T, (v: T | ((p: T) => T)) => void, React.MutableRefObject<T>] {
  const [value, setValue] = useState(init)
  const ref = useRef(init)
  const set = useCallback((next: T | ((p: T) => T)) => {
    ref.current = typeof next === 'function' ? (next as (p: T) => T)(ref.current) : next
    setValue(ref.current)
  }, [])
  return [value, set, ref]
}

type Screen = 'list' | 'models' | 'key' | 'custom' | 'ctx' | 'add-model' | 'filter' | 'confirm'
type Row =
  | { kind: 'provider'; name: string; entry: ProviderEntry }
  | { kind: 'preset'; preset: ProviderPreset }
  | { kind: 'custom' }

const CUSTOM_STEPS = ['name', 'type', 'url', 'key', 'models'] as const
type CustomStep = (typeof CUSTOM_STEPS)[number]

const ORIGIN_COLOR: Record<WindowOrigin, string | undefined> = { manual: theme.brand, api: undefined, known: undefined, assumed: theme.warn }
const ORIGIN_LABEL: Record<WindowOrigin, string> = { manual: 'manual', api: 'from API', known: 'known', assumed: 'assumed' }

/** `think:medium` for models that support it; nothing for the rest. */
function thinkTag(cfg: VaraConfig, prov: string, id: string): React.ReactElement | null {
  const { support, level } = thinkingFor(cfg, id, prov)
  if (!support || !level) return null
  return <Text color={level === 'off' ? theme.muted : theme.accent}> · think:{level}</Text>
}

function StatusDot({ status }: { status: 'ok' | 'fail' | 'unknown' }): React.ReactElement {
  if (status === 'ok') return <Text color={theme.ok}>{glyph.dot}</Text>
  if (status === 'fail') return <Text color={theme.err}>{glyph.dot}</Text>
  return <Text dimColor>○</Text>
}

export function ProviderManager({
  config,
  initial = 'list',
  maxRows = 10,
  deps: depsOverride,
  onChange,
  onUse,
  onClose,
}: {
  config: VaraConfig
  initial?: 'list' | 'models'
  maxRows?: number
  deps?: Partial<ManagerDeps>
  /** Called after every edit (providers, models, status, context) — persist it. */
  onChange: (config: VaraConfig) => void
  /** Called when the user picks a model to use. */
  onUse: (config: VaraConfig) => void
  onClose: () => void
}): React.ReactElement {
  const deps: ManagerDeps = { ...defaultDeps, ...depsOverride }
  const depsRef = useRef(deps)
  depsRef.current = deps

  const [cfg, setCfg] = useState(config)
  const cfgRef = useRef(config)
  const [screen, setScreen, screenR] = useSync<Screen>(initial === 'models' ? 'models' : 'list')
  const [prov, setProv, provR] = useSync(activeProviderName(config))
  const [index, setIndex, indexR] = useSync(0)
  const [query, setQuery, queryR] = useSync('')
  const [text, setText, textR] = useSync('')
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'err' | 'info' } | null>(null)
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [pendingPreset, setPendingPreset, presetR] = useSync<ProviderPreset | null>(null)
  const [custom, setCustom, customR] = useSync<{ step: CustomStep; name: string; type: 'openai' | 'anthropic'; url: string; key: string }>({
    step: 'name',
    name: '',
    type: 'openai',
    url: '',
    key: '',
  })
  const [ctxStep, setCtxStep, ctxR] = useSync<{ stage: 'window' | 'output'; window?: number | null }>({ stage: 'window' })
  const mounted = useRef(true)
  const busyRef = useRef(false)
  useEffect(
    () => () => {
      mounted.current = false
    },
    [],
  )

  const say = useCallback((text: string, tone: 'ok' | 'err' | 'info' = 'info') => {
    if (mounted.current) setMsg({ text, tone })
  }, [])

  /** Apply an edit to the LATEST config (async tasks must not use stale state). */
  const commit = useCallback(
    (fn: (c: VaraConfig) => VaraConfig): VaraConfig => {
      const next = fn(cfgRef.current)
      cfgRef.current = next
      if (mounted.current) setCfg(next)
      onChange(next)
      return next
    },
    [onChange],
  )

  const refreshKeys = useCallback(async () => {
    const out: Record<string, string> = {}
    for (const [name, entry] of Object.entries(cfgRef.current.providers)) out[name] = await depsRef.current.keyState(entry)
    if (mounted.current) setKeys(out)
  }, [])
  useEffect(() => {
    void refreshKeys()
  }, [refreshKeys, cfg.providers])

  /** Run a long task with a busy banner; only one at a time. */
  const run = useCallback(async (label: string, task: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true
    if (mounted.current) {
      setBusy(label)
      setMsg(null)
    }
    try {
      await task()
    } catch (err) {
      say(scrubAll((err as Error).message), 'err')
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(null)
    }
  }, [say])

  const fetchModels = useCallback(
    (name: string) =>
      run(`Fetching models from ${name}…`, async () => {
        const entry = cfgRef.current.providers[name]
        if (!entry) return
        const found = await depsRef.current.discover(await depsRef.current.endpoint(entry))
        if (!found.length) {
          say('The provider returned no models — add one with n.', 'err')
          return
        }
        commit((c) => mergeDiscovered(c, name, found))
        say(`${glyph.ok} ${found.length} models available — press t to test one, a to test all`, 'ok')
      }),
    [run, commit, say],
  )

  const testModels = useCallback(
    (name: string, ids: string[]) =>
      run(`Testing ${ids.length} model${ids.length === 1 ? '' : 's'}…`, async () => {
        const entry = cfgRef.current.providers[name]
        if (!entry || !ids.length) return
        const ep = await depsRef.current.endpoint(entry)
        let done = 0
        let okCount = 0
        await mapLimit(ids, 4, async (id) => {
          const r = await depsRef.current.check(ep, id)
          if (r.status === 'ok') okCount++
          commit((c) => (c.providers[name]?.models[id] ? setModelStatus(c, name, id, r.status, r.detail) : c))
          done++
          if (mounted.current) setBusy(`Testing models… ${done}/${ids.length}`)
        })
        say(`${okCount}/${ids.length} working`, okCount === ids.length ? 'ok' : okCount === 0 ? 'err' : 'info')
      }),
    [run, commit, say],
  )

  /* ---------------- derived lists ---------------- */
  /** Computed from the refs so the key handler and the render always agree. */
  const derive = () => {
    const c = cfgRef.current
    const activeName = activeProviderName(c)
    const configured = Object.entries(c.providers)
      .sort(([x], [y]) => (x === activeName ? -1 : y === activeName ? 1 : x.localeCompare(y)))
      .map(([name, e]): Row => ({ kind: 'provider', name, entry: e }))
    const available = PRESETS.filter((p) => !c.providers[p.name]).map((preset): Row => ({ kind: 'preset', preset }))
    // "Custom provider" sits right under the configured ones so it is always in view.
    const rows: Row[] = [...configured, { kind: 'custom' }, ...available]
    const entry = c.providers[provR.current]
    const allModels = Object.entries(entry?.models ?? {}).sort(([x], [y]) => x.localeCompare(y))
    const q = queryR.current.toLowerCase()
    const modelRows = q ? allModels.filter(([id]) => id.toLowerCase().includes(q)) : allModels
    const listLen = screenR.current === 'list' ? rows.length : modelRows.length
    const sel = Math.min(indexR.current, Math.max(0, listLen - 1))
    return { c, activeName, rows, entry, allModels, modelRows, listLen, sel }
  }
  const { activeName, rows, entry, allModels, modelRows, sel } = derive()

  /* ---------------- actions ---------------- */
  const openProvider = (name: string) => {
    setProv(name)
    setQuery('')
    setIndex(0)
    setScreen('models')
  }

  const beginKey = (name: string, preset: ProviderPreset | null) => {
    setPendingPreset(preset)
    setProv(name)
    setText('')
    setMsg(null)
    setScreen('key')
  }

  const finishAddPreset = async (preset: ProviderPreset, key: string) => {
    await run('Saving…', async () => {
      if (key) await depsRef.current.saveKey(secretNameFor(preset.name), key)
      commit((c) => (c.providers[preset.name] ? c : addProviderFromPreset(c, preset)))
      openProvider(preset.name)
    })
    void fetchModels(preset.name)
  }

  const submitKey = async () => {
    const key = textR.current.replace(/\s+/g, '')
    setText('')
    const p = presetR.current
    const name = p?.name ?? provR.current
    const e = cfgRef.current.providers[name]
    const envName = p?.apiKeyEnv ?? e?.apiKeyEnv ?? ''
    const hasEnv = !!(envName && process.env[envName])
    if (!key && !hasEnv) {
      say('Paste your API key (it is stored encrypted in the vault, never shown).', 'err')
      return
    }
    if (p) {
      await finishAddPreset(p, key)
      return
    }
    await run('Saving key…', async () => {
      if (key) await depsRef.current.saveKey(e?.apiKeySecret || secretNameFor(name), key)
      setScreen('models')
      say(`${glyph.ok} key saved for ${name}`, 'ok')
    })
    void refreshKeys()
    void fetchModels(name)
  }

  const submitCustom = async (value: string) => {
    const v = value.trim()
    const c = customR.current
    if (c.step === 'name') {
      const name = v.toLowerCase()
      if (!validProviderName(name)) return say('Use lowercase letters, digits, "-" or "_" (e.g. my-llm).', 'err')
      if (cfgRef.current.providers[name]) return say(`"${name}" already exists.`, 'err')
      setCustom({ ...c, name, step: 'type' })
      setText('')
      return say('', 'info')
    }
    if (c.step === 'type') {
      setCustom({ ...c, step: 'url' })
      setText('')
      return
    }
    if (c.step === 'url') {
      if (!/^https?:\/\//i.test(v)) return say('Base URL must start with http:// or https://', 'err')
      setCustom({ ...c, url: v, step: 'key' })
      setText('')
      return say('', 'info')
    }
    if (c.step === 'key') {
      setCustom({ ...c, key: v.replace(/\s+/g, ''), step: 'models' })
      setText('')
      return
    }
    // models: empty → fetch all; otherwise a comma-separated list.
    const ids = v.split(/[,\s]+/).filter(Boolean)
    await run('Adding provider…', async () => {
      commit((cur) => addCustomProvider(cur, { name: c.name, type: c.type, baseUrl: c.url, keyless: !c.key, models: ids }))
      if (c.key) await depsRef.current.saveKey(secretNameFor(c.name), c.key)
      openProvider(c.name)
    })
    setCustom({ step: 'name', name: '', type: 'openai', url: '', key: '' })
    setText('')
    if (!ids.length) void fetchModels(c.name)
    else void testModels(c.name, ids)
  }

  const use = (name: string, model: string) => {
    try {
      onUse(activate(cfgRef.current, name, model))
    } catch (err) {
      say((err as Error).message, 'err')
    }
  }

  /* ---------------- keyboard ---------------- */
  useInput((raw, key) => {
    if (busyRef.current) return // one thing at a time; the banner says what
    const screen = screenR.current
    const text = textR.current
    const query = queryR.current
    const prov = provR.current
    const custom = customR.current
    const ctxStep = ctxR.current
    const pendingPreset = presetR.current
    const { rows, entry, modelRows, listLen, sel } = derive()

    const typing = (setter: (fn: (s: string) => string) => void): boolean => {
      if (key.backspace || key.delete) {
        setter((s) => s.slice(0, -1))
        return true
      }
      if (raw && !key.ctrl && !key.meta && !key.return && !key.escape && !key.tab && raw >= ' ') {
        setter((s) => s + raw.replace(/[\r\n]/g, ''))
        return true
      }
      return false
    }

    /* text-entry screens */
    if (screen === 'key') {
      if (key.escape) {
        setScreen(pendingPreset ? 'list' : 'models')
        setPendingPreset(null)
        setText('')
        return
      }
      if (key.return) return void submitKey()
      typing(setText)
      return
    }
    if (screen === 'custom') {
      if (key.escape) {
        setScreen('list')
        setCustom({ step: 'name', name: '', type: 'openai', url: '', key: '' })
        setText('')
        setMsg(null)
        return
      }
      if (custom.step === 'type') {
        if (key.tab || key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
          setCustom((c) => ({ ...c, type: c.type === 'openai' ? 'anthropic' : 'openai' }))
          return
        }
        if (key.return) return void submitCustom('')
        return
      }
      if (key.return) return void submitCustom(text)
      typing(setText)
      return
    }
    if (screen === 'ctx') {
      if (key.escape) {
        setScreen('models')
        setText('')
        return
      }
      if (key.return) {
        const parsed = parseTokens(text)
        if (parsed === undefined) return say('Enter a number like 128000, 128k or 1m (min 256) — empty resets to automatic.', 'err')
        const id = modelRows[sel]?.[0]
        if (!id) return
        if (ctxStep.stage === 'window') {
          setCtxStep({ stage: 'output', window: parsed })
          setText('')
          setMsg(null)
          return
        }
        commit((c) => setModelContext(c, prov, id, { contextWindow: ctxStep.window ?? null, maxOutputTokens: parsed }))
        say(`${glyph.ok} context settings saved for ${id}`, 'ok')
        setScreen('models')
        setText('')
        return
      }
      typing(setText)
      return
    }
    if (screen === 'add-model') {
      if (key.escape) {
        setScreen('models')
        setText('')
        return
      }
      if (key.return) {
        const id = text.trim()
        if (!id) return
        commit((c) => addModel(c, prov, id))
        setText('')
        setScreen('models')
        void testModels(prov, [id])
        return
      }
      typing(setText)
      return
    }
    if (screen === 'filter') {
      if (key.escape) {
        setQuery('')
        setScreen('models')
        return
      }
      if (key.return) {
        setScreen('models')
        return
      }
      if (typing(setQuery)) setIndex(0)
      return
    }
    if (screen === 'confirm') {
      if (raw === 'y' || raw === 'Y') {
        try {
          commit((c) => removeProvider(c, prov))
          say(`removed ${prov}`, 'ok')
        } catch (err) {
          say((err as Error).message, 'err')
        }
        setScreen('list')
        setIndex(0)
        return
      }
      setScreen('list')
      return
    }

    /* navigation (list / models) */
    const total = listLen
    if (key.upArrow) return setIndex(Math.max(0, sel - 1))
    if (key.downArrow) return setIndex(Math.min(total - 1, sel + 1))
    if (key.pageUp) return setIndex(Math.max(0, sel - maxRows))
    if (key.pageDown) return setIndex(Math.min(total - 1, sel + maxRows))

    if (screen === 'list') {
      const row = rows[sel]
      if (key.escape) return onClose()
      if (!row) return
      if (key.return) {
        if (row.kind === 'custom') {
          setScreen('custom')
          setText('')
          setMsg(null)
          return
        }
        if (row.kind === 'preset') {
          if (row.preset.keyless) return void finishAddPreset(row.preset, '')
          return beginKey(row.preset.name, row.preset)
        }
        if ((keys[row.name] ?? '') === 'none') return beginKey(row.name, null)
        return openProvider(row.name)
      }
      if (raw === 'k' && row.kind === 'provider' && !row.entry.keyless) return beginKey(row.name, null)
      if (raw === 'd' && row.kind === 'provider') {
        if (row.name === activeName) return say('That provider is in use — switch to another one first.', 'err')
        setProv(row.name)
        return setScreen('confirm')
      }
      return
    }

    // models screen
    const id = modelRows[sel]?.[0]
    if (key.escape) {
      if (query) return setQuery('')
      return initial === 'models' ? onClose() : setScreen('list')
    }
    if (key.return) {
      if (!id) return
      return use(prov, id)
    }
    if (raw === 't' && id) return void testModels(prov, [id])
    if (raw === 'a') return void testModels(prov, modelRows.slice(0, 60).map(([m]) => m))
    if (raw === 'r') return void fetchModels(prov)
    if (raw === 'n') {
      setText('')
      return setScreen('add-model')
    }
    if (raw === '/') {
      setScreen('filter')
      return
    }
    if (raw === 'k' && entry && !entry.keyless) return beginKey(prov, null)
    if (raw === 'h' && id) {
      const { support, level } = thinkingFor(cfgRef.current, id, prov)
      if (!support) return say('This model has no thinking control (it is not a reasoning model on this endpoint).', 'info')
      const next = nextLevel(support, level)
      commit((c) => setModelThinking(c, prov, id, next))
      return say(`thinking → ${next} (${support.note}) — applies to work turns`, 'ok')
    }
    if (raw === 'c' && id) {
      setCtxStep({ stage: 'window' })
      setText('')
      setMsg(null)
      return setScreen('ctx')
    }
    if (raw === 'x' && id) {
      try {
        commit((c) => removeModel(c, prov, id))
        say(`removed ${id}`, 'ok')
      } catch (err) {
        say((err as Error).message, 'err')
      }
    }
  })

  /* ---------------- rendering ---------------- */
  const tone = msg?.tone === 'ok' ? theme.ok : msg?.tone === 'err' ? theme.err : undefined
  const masked = '•'.repeat(Math.min(text.length, 40))
  const Banner = (
    <>
      {busy ? (
        <Text color={theme.warn}>
          {glyph.pending} {busy}
        </Text>
      ) : msg && msg.text ? (
        <Text color={tone} wrap="truncate-end">
          {msg.text}
        </Text>
      ) : null}
    </>
  )

  if (screen === 'key') {
    const p = pendingPreset
    const name = p?.name ?? prov
    const e = cfg.providers[name]
    const envName = p?.apiKeyEnv ?? e?.apiKeyEnv ?? ''
    const hasEnv = !!(envName && process.env[envName])
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1} marginBottom={1}>
        <Text bold color={theme.brand}>
          API key — {p?.label ?? e?.label ?? name}
        </Text>
        {p ? <Text dimColor>Get one at {p.note}</Text> : null}
        <Box marginTop={1}>
          <Text color={theme.brand}>▸ </Text>
          <Text>
            {masked}
            <Text inverse> </Text>
            {!text ? <Text dimColor>paste your key</Text> : null}
          </Text>
        </Box>
        {hasEnv ? <Text color={theme.ok}>found ${envName} in your environment — press Enter to use it</Text> : null}
        <Text dimColor>Stored encrypted in the VARA vault. Never printed or logged.</Text>
        {Banner}
        <Text dimColor>Enter save · Esc cancel</Text>
      </Box>
    )
  }

  if (screen === 'custom') {
    const labels: Record<CustomStep, string> = {
      name: 'Provider name (e.g. my-llm)',
      type: 'Protocol — Tab switches',
      url: 'Base URL (e.g. https://llm.example.com/v1)',
      key: 'API key (leave empty for none — local server)',
      models: 'Models: Enter fetches ALL from the provider, or type ids separated by commas',
    }
    const idx = CUSTOM_STEPS.indexOf(custom.step)
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1} marginBottom={1}>
        <Text bold color={theme.brand}>
          Custom provider <Text dimColor>· step {idx + 1}/{CUSTOM_STEPS.length}</Text>
        </Text>
        {custom.name ? <Text dimColor>name: {custom.name}</Text> : null}
        {custom.step !== 'name' && custom.step !== 'type' ? <Text dimColor>protocol: {custom.type === 'openai' ? 'OpenAI-compatible' : 'Anthropic'}</Text> : null}
        {custom.url ? <Text dimColor>url: {custom.url}</Text> : null}
        <Box marginTop={1} flexDirection="column">
          <Text>{labels[custom.step]}</Text>
          {custom.step === 'type' ? (
            <Text>
              <Text inverse={custom.type === 'openai'}> OpenAI-compatible </Text>
              <Text> </Text>
              <Text inverse={custom.type === 'anthropic'}> Anthropic </Text>
            </Text>
          ) : (
            <Text>
              <Text color={theme.brand}>▸ </Text>
              {custom.step === 'key' ? masked : text}
              <Text inverse> </Text>
            </Text>
          )}
        </Box>
        {Banner}
        <Text dimColor>Enter next · Esc cancel</Text>
      </Box>
    )
  }

  if (screen === 'ctx' || screen === 'add-model') {
    const id = modelRows[sel]?.[0] ?? ''
    const o = id ? contextOrigin(cfg, prov, id) : null
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1} marginBottom={1}>
        <Text bold color={theme.brand}>
          {screen === 'add-model' ? `Add a model to ${prov}` : `Context settings — ${id}`}
        </Text>
        {screen === 'ctx' && o ? (
          <Text dimColor>
            currently {formatTokens(o.windowTokens)} tokens ({ORIGIN_LABEL[o.origin]})
          </Text>
        ) : null}
        <Box marginTop={1} flexDirection="column">
          <Text>
            {screen === 'add-model'
              ? 'Model id exactly as the provider expects it:'
              : ctxStep.stage === 'window'
                ? 'Context window in tokens (e.g. 128k, 1m) — empty = automatic:'
                : 'Output reserve in tokens (room kept for the answer) — empty = automatic:'}
          </Text>
          <Text>
            <Text color={theme.brand}>▸ </Text>
            {text}
            <Text inverse> </Text>
          </Text>
        </Box>
        {Banner}
        <Text dimColor>Enter {screen === 'ctx' && ctxStep.stage === 'window' ? 'next' : 'save'} · Esc cancel</Text>
      </Box>
    )
  }

  if (screen === 'confirm') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.warn} paddingX={1} marginBottom={1}>
        <Text bold color={theme.warn}>
          Remove provider “{prov}” and all its model settings?
        </Text>
        <Text dimColor>The stored key stays in the vault. y = remove · any other key = cancel</Text>
      </Box>
    )
  }

  if (screen === 'list') {
    const start = windowStart(sel, maxRows, rows.length)
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1} marginBottom={1}>
        <Text bold color={theme.brand}>
          Providers
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {rows.slice(start, start + maxRows).map((row, i) => {
            const at = start + i === sel
            const pointer = at ? '▸ ' : '  '
            if (row.kind === 'custom') {
              return (
                <Text key="custom" inverse={at}>
                  {pointer}
                  <Text color={theme.brand}>+ Custom provider</Text>
                  <Text dimColor> — any OpenAI-compatible or Anthropic endpoint</Text>
                </Text>
              )
            }
            if (row.kind === 'preset') {
              return (
                <Text key={row.preset.name} inverse={at} wrap="truncate-end">
                  {pointer}
                  <Text dimColor>+ {row.preset.label}</Text>
                  <Text dimColor> — {row.preset.note}</Text>
                </Text>
              )
            }
            const models = Object.values(row.entry.models)
            const ok = models.filter((m) => m.status === 'ok').length
            const bad = models.filter((m) => m.status === 'fail').length
            const ks = keys[row.name]
            return (
              <Text key={row.name} inverse={at} wrap="truncate-end">
                {pointer}
                <Text color={row.name === activeName ? theme.ok : undefined}>{row.name === activeName ? '● ' : '○ '}</Text>
                <Text bold>{row.entry.label ?? row.name}</Text>
                <Text dimColor> · {models.length} models</Text>
                {ok ? <Text color={theme.ok}> · {ok} ok</Text> : null}
                {bad ? <Text color={theme.err}> · {bad} down</Text> : null}
                {ks === 'none' ? <Text color={theme.warn}> · no key — Enter to add</Text> : null}
                {ks === 'env' ? <Text dimColor> · key from env</Text> : null}
                {row.name === activeName ? <Text color={theme.ok}> · in use ({cfg.provider.model})</Text> : null}
              </Text>
            )
          })}
        </Box>
        <Box marginTop={1}>{Banner}</Box>
        <Text dimColor>↑↓ move · Enter open / add · k key · d remove · Esc close</Text>
      </Box>
    )
  }

  // models screen
  const start = windowStart(sel, maxRows, modelRows.length)
  const selId = modelRows[sel]?.[0]
  const selModel = selId ? entry?.models[selId] : undefined
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1} marginBottom={1}>
      <Text bold color={theme.brand}>
        Models — {entry?.label ?? prov}{' '}
        <Text dimColor>
          · {allModels.length} total{query ? ` · filter “${query}”` : ''}
        </Text>
        {screen === 'filter' ? <Text color={theme.warn}> · typing filter: {query}▏</Text> : null}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {modelRows.length === 0 ? (
          <Text dimColor>{allModels.length ? 'No model matches.' : 'No models yet — press r to fetch them from the provider, or n to add one.'}</Text>
        ) : (
          modelRows.slice(start, start + maxRows).map(([id, m], i) => {
            const at = start + i === sel
            const o = contextOrigin(cfg, prov, id)
            const inUse = prov === activeName && id === cfg.provider.model
            return (
              <Text key={id} inverse={at} wrap="truncate-end">
                {at ? '▸ ' : '  '}
                <StatusDot status={m.status} /> <Text bold={inUse}>{id}</Text>
                {inUse ? <Text color={theme.ok}> (in use)</Text> : null}
                <Text dimColor> · ctx {formatTokens(o.windowTokens)} </Text>
                <Text color={ORIGIN_COLOR[o.origin]} dimColor={!ORIGIN_COLOR[o.origin]}>
                  {ORIGIN_LABEL[o.origin]}
                </Text>
                {m.maxOutputTokens ? <Text dimColor> · out {formatTokens(m.maxOutputTokens)}</Text> : null}
                {thinkTag(cfg, prov, id)}
              </Text>
            )
          })
        )}
        {modelRows.length > maxRows ? (
          <Text dimColor>
            {sel + 1}/{modelRows.length}
          </Text>
        ) : null}
      </Box>
      {selModel && selModel.status !== 'unknown' && selModel.statusDetail ? (
        <Text color={selModel.status === 'ok' ? theme.ok : theme.err} wrap="truncate-end">
          {selModel.status === 'ok' ? glyph.ok : glyph.fail} {selId}: {selModel.statusDetail}
        </Text>
      ) : null}
      <Box marginTop={1}>{Banner}</Box>
      <Text dimColor wrap="truncate-end">
        <Text color={theme.ok}>●</Text> works · <Text color={theme.err}>●</Text> down · ○ untested
      </Text>
      <Text dimColor>Enter use · t test · a test all · r refresh · c context · h thinking · n add · x remove · / filter · Esc back</Text>
    </Box>
  )
}

