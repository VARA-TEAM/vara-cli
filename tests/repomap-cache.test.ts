import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildIndex, findSymbols, indexFile, invalidateRepoMap, outlineOf, rankFiles, renderMap } from '../src/core/repomap.js'
import { readSymbolTool, repoMapTool, toolOutputTool } from '../src/tools/repo-tools.js'
import { readFileTool, OUTLINE_MARK } from '../src/tools/fs-tools.js'
import { placeMessageBreakpoints, type AnthropicMessage } from '../src/llm/cache.js'
import { OutputStore } from '../src/core/outputs.js'
import type { ToolContext } from '../src/tools/types.js'

let root: string
const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({ cwd: root, mode: 'build', sessionId: 's', scope: 'session:s', env: {}, allowPublish: false, ...extra })

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'vara-repomap-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'x'), { recursive: true })
  await writeFile(join(root, 'node_modules', 'x', 'index.js'), 'function ignoredThing() {}\n')
  await writeFile(
    join(root, 'src', 'store.ts'),
    [
      'export interface Session { id: string }',
      '',
      'export function saveSession(s: Session): Promise<void> {',
      '  const x = { a: "}" }',
      '  return Promise.resolve()',
      '}',
      '',
      'export class Store {',
      '  load(id: string): Session | null {',
      '    return null',
      '  }',
      '}',
      '',
      'const helperOnlyHere = (n: number) => n + 1',
    ].join('\n'),
  )
  await writeFile(join(root, 'src', 'engine.ts'), ['import { saveSession } from "./store"', 'export function run() {', '  saveSession({ id: "1" })', '}', 'export function stop() {', '  saveSession({ id: "2" })', '}'].join('\n'))
  await writeFile(join(root, 'src', 'cli.ts'), ['import { saveSession, Store } from "./store"', 'export function main() {', '  saveSession({ id: "3" })', '  return new Store()', '}'].join('\n'))
  await writeFile(join(root, 'tool.py'), ['def parse(text):', '    return text.strip()', '', 'class Parser:', '    def run(self):', '        return parse("x")', '', 'def other():', '    pass'].join('\n'))
  // a long file
  const long: string[] = ['export function first() {', '  return 1', '}']
  for (let i = 0; i < 1100; i++) long.push(`// filler line ${i}`)
  long.push('export function last() {', '  return 2', '}')
  await writeFile(join(root, 'src', 'long.ts'), long.join('\n'))
})
afterAll(async () => {
  invalidateRepoMap()
  await rm(root, { recursive: true, force: true })
})

describe('repo map', () => {
  it('finds functions, classes, types and python defs with their line ranges, and skips node_modules', async () => {
    const idx = await buildIndex(root, true)
    const paths = idx.files.map((f) => f.path)
    expect(paths).toContain('src/store.ts')
    expect(paths).not.toContain('node_modules/x/index.js')
    const store = idx.files.find((f) => f.path === 'src/store.ts')!
    const save = store.syms.find((s) => s.name === 'saveSession')!
    expect(save).toMatchObject({ kind: 'function', line: 3, endLine: 6 }) // the "}" inside a string does not end it early
    expect(store.syms.find((s) => s.name === 'Store')).toMatchObject({ kind: 'class', line: 8, endLine: 12 })
    expect(store.syms.find((s) => s.name === 'Session')!.kind).toBe('interface')
    expect(store.syms.some((s) => s.name === 'helperOnlyHere')).toBe(true)
    const py = idx.files.find((f) => f.path === 'tool.py')!
    expect(py.syms.find((s) => s.name === 'parse')).toMatchObject({ line: 1, endLine: 2 })
    expect(py.syms.find((s) => s.name === 'Parser')).toMatchObject({ kind: 'class', line: 4, endLine: 6 })
  })

  it('ranks the file the rest of the project leans on first, and a query pulls its matches up', async () => {
    const idx = await buildIndex(root)
    expect(rankFiles(idx)[0]!.file.path).toBe('src/store.ts') // engine.ts mentions saveSession
    expect(rankFiles(idx, 'parser')[0]!.file.path).toBe('tool.py')
  })

  it('renders within a token budget and says how to read more', async () => {
    const idx = await buildIndex(root)
    const small = renderMap(idx, { budgetTokens: 200 })
    expect(small).toContain('repo map:')
    expect(small).toContain('read_symbol')
    expect(small.length).toBeLessThan(200 * 4 + 900)
    expect(renderMap(idx, { path: 'src/store' })).not.toContain('tool.py')
  })

  it('tools: repo_map, read_symbol (just the lines of one symbol) and a clear miss', async () => {
    const m = await repoMapTool.execute({ query: 'save session' }, ctx())
    expect(m.output).toContain('src/store.ts')
    const r = await readSymbolTool.execute({ name: 'saveSession' }, ctx())
    expect(r.ok).toBe(true)
    expect(r.output).toContain('src/store.ts:3-6')
    expect(r.output).toContain('return Promise.resolve()')
    expect(r.output).not.toContain('class Store')
    const miss = await readSymbolTool.execute({ name: 'doesNotExist' }, ctx())
    expect(miss.ok).toBe(false)
    expect(findSymbols(await buildIndex(root), 'parse', 'tool.py')).toHaveLength(1)
  })

  it('a long file read without a range comes back as an outline + first lines; with a range it is exact', async () => {
    const outline = await readFileTool.execute({ path: 'src/long.ts' }, ctx())
    expect(outline.output).toContain(OUTLINE_MARK)
    expect(outline.output).toContain('first()')
    expect(outline.output).toContain('last()')
    expect(outline.output.length).toBeLessThan(4_000)
    const slice = await readFileTool.execute({ path: 'src/long.ts', offset: 1104, limit: 3 }, ctx())
    expect(slice.output).not.toContain(OUTLINE_MARK)
    expect(slice.output).toContain('export function last()')
    const off = await readFileTool.execute({ path: 'src/long.ts' }, ctx({ smartRead: false }))
    expect(off.output).not.toContain(OUTLINE_MARK)
  })

  it('outlineOf gives a compact structure', () => {
    expect(outlineOf('a.ts', 'export function a() {\n  return 1\n}\nexport class B {\n}\n')).toContain('1-3 export function a()')
    expect(indexFile('x.go', 'func Run(a int) {\n}\n').syms[0]).toMatchObject({ name: 'Run', kind: 'func' })
  })

  it('tool_output answers from the store and refuses unknown ids', async () => {
    const store = new OutputStore(null)
    store.put('abc', 'one\ntwo\nthree needle\nfour')
    const ok = await toolOutputTool.execute({ id: 'abc', grep: 'needle' }, ctx({ outputs: store }))
    expect(ok.output).toContain('three needle')
    const bad = await toolOutputTool.execute({ id: 'zzz' }, ctx({ outputs: store }))
    expect(bad.ok).toBe(false)
    const noStore = await toolOutputTool.execute({ id: 'abc' }, ctx())
    expect(noStore.ok).toBe(false)
  })
})

describe('Anthropic cache breakpoints', () => {
  const user = (c: unknown): AnthropicMessage => ({ role: 'user', content: c })
  const asst = (c: unknown): AnthropicMessage => ({ role: 'assistant', content: c })
  const marked = (m: AnthropicMessage) => Array.isArray(m.content) && (m.content as Array<Record<string, unknown>>).some((b) => b['cache_control'])

  it('marks the last message AND the previous user message (where the last request ended)', () => {
    const msgs: AnthropicMessage[] = [
      user('objective'),
      asst([{ type: 'tool_use', id: '1', name: 'a', input: {} }]),
      user([{ type: 'tool_result', tool_use_id: '1', content: 'r1' }]),
      asst([{ type: 'tool_use', id: '2', name: 'a', input: {} }]),
      user([{ type: 'tool_result', tool_use_id: '2', content: 'r2' }]),
    ]
    expect(placeMessageBreakpoints(msgs)).toBe(2)
    expect(marked(msgs[4]!)).toBe(true)
    expect(marked(msgs[2]!)).toBe(true)
    expect(marked(msgs[0]!)).toBe(false)
    expect(marked(msgs[1]!)).toBe(false)
  })

  it('works with a single message and with a string body', () => {
    const one: AnthropicMessage[] = [user('hello')]
    expect(placeMessageBreakpoints(one)).toBe(1)
    expect(marked(one[0]!)).toBe(true)
    expect(placeMessageBreakpoints([])).toBe(0)
  })

  it('never exceeds the provider limit of 4 breakpoints together with tools + system', () => {
    // tools (1) + system (1) are added by the provider; messages add at most 2.
    const msgs: AnthropicMessage[] = [user('a'), asst('b'), user('c'), asst('d'), user('e')]
    expect(placeMessageBreakpoints(msgs)).toBeLessThanOrEqual(2)
  })
})

describe('provider requests carry the cache hints', () => {
  const sse = (frames: string[]): Response => {
    const enc = new TextEncoder()
    return new Response(new ReadableStream<Uint8Array>({ start(c) { for (const f of frames) c.enqueue(enc.encode(f)); c.close() } }), { status: 200 })
  }
  const drain = async (it: AsyncIterable<unknown>): Promise<void> => {
    for await (const _ of it) void _
  }

  it('Anthropic: tools + system + last message + previous user message = 4 breakpoints', async () => {
    const { anthropicProvider } = await import('../src/llm/anthropic.js')
    const { vi } = await import('vitest')
    let body: { tools: Array<Record<string, unknown>>; system: Array<Record<string, unknown>>; messages: Array<{ role: string; content: unknown }> } | null = null
    vi.stubGlobal('fetch', vi.fn(async (_u: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return sse(['data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n', 'data: {"type":"message_delta","usage":{"output_tokens":1}}\n\n'])
    }))
    const p = anthropicProvider({ id: 'anthropic', baseUrl: 'https://fake.example', apiKey: 'k', model: 'claude-3-5-sonnet' })
    await drain(
      p.chat({
        system: 'sys',
        model: 'claude-3-5-sonnet',
        tools: [{ type: 'function', function: { name: 'a', description: '', parameters: { type: 'object', properties: {} } } }],
        messages: [
          { role: 'user', content: 'objective' },
          { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'a', arguments: '{}' }] },
          { role: 'tool', content: 'r1', toolCallId: '1' },
          { role: 'assistant', content: '', toolCalls: [{ id: '2', name: 'a', arguments: '{}' }] },
          { role: 'tool', content: 'r2', toolCallId: '2' },
        ],
      }),
    )
    vi.unstubAllGlobals()
    const b = body!
    const count = (v: unknown): number => JSON.stringify(v).split('cache_control').length - 1
    expect(count(b.tools)).toBe(1)
    expect(count(b.system)).toBe(1)
    expect(count(b.messages)).toBe(2)
    expect(count(b)).toBeLessThanOrEqual(4)
  })

  it('OpenAI: prompt_cache_key only goes to api.openai.com', async () => {
    const { openaiProvider } = await import('../src/llm/openai.js')
    const { vi } = await import('vitest')
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (_u: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return sse(['data: [DONE]\n\n'])
    }))
    for (const baseUrl of ['https://api.openai.com/v1', 'https://other.example/v1']) {
      const p = openaiProvider({ id: 'openai', baseUrl, apiKey: 'k', model: 'gpt-4o' })
      await drain(p.chat({ system: 's', model: 'gpt-4o', tools: [], messages: [{ role: 'user', content: 'x' }], cacheKey: 'sess-1' }))
    }
    vi.unstubAllGlobals()
    expect(bodies[0]!['prompt_cache_key']).toBe('sess-1')
    expect(bodies[1]!['prompt_cache_key']).toBeUndefined()
  })
})
