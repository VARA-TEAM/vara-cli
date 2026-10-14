import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { ToolContext } from '../src/tools/types.js'
import { makeGlobTool, makeGrepTool, globTool } from '../src/tools/search.js'

let workdir: string
let ctx: ToolContext

/** ripgrep-engine tests need `rg` on PATH (CI installs it; the node engine is always tested). */
const HAS_RG = spawnSync('rg', ['--version']).status === 0
const rgIt = it.skipIf(!HAS_RG)

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'vara-search-'))
  ctx = {
    cwd: workdir,
    mode: 'build',
    sessionId: 'test',
    scope: 'session:test',
    env: { ...process.env } as Record<string, string>,
    allowPublish: false,
  }

  // A small tree exercising nesting, .gitignore, and hidden dirs.
  await mkdir(join(workdir, 'src', 'nested'), { recursive: true })
  await mkdir(join(workdir, 'build'), { recursive: true })
  await mkdir(join(workdir, '.hidden'), { recursive: true })
  await writeFile(join(workdir, 'src', 'a.ts'), 'const alpha = 1\nexport { alpha }\n')
  await writeFile(join(workdir, 'src', 'nested', 'b.ts'), 'const beta = 2\n// alpha marker\n')
  await writeFile(join(workdir, 'src', 'note.md'), '# alpha in markdown\n')
  await writeFile(join(workdir, 'build', 'generated.ts'), 'const alpha = 999\n')
  await writeFile(join(workdir, '.hidden', 'secret.ts'), 'const alpha = 42\n')
  await writeFile(join(workdir, '.gitignore'), 'build/\n*.log\n')
  await writeFile(join(workdir, 'debug.log'), 'alpha noise\n')
})

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true })
})

describe('glob tool (path search)', () => {
  it('is registered under the expected name and is read-only for plan mode', () => {
    expect(globTool.name).toBe('glob')
    expect(globTool.readonly).toBe(true)
  })

  rgIt('finds nested .ts files with a ** pattern (ripgrep engine)', async () => {
    const tool = makeGlobTool('ripgrep')
    const result = await tool.execute({ pattern: '**/*.ts' }, ctx)
    expect(result.ok).toBe(true)
    // build/ and .hidden/ are excluded by .gitignore and the hidden filter.
    expect(result.output).toContain('src/a.ts')
    expect(result.output).toContain('src/nested/b.ts')
    expect(result.output).not.toContain('generated.ts')
    expect(result.output).not.toContain('secret.ts')
  })

  it('finds files with the pure-Node engine and still honors .gitignore', async () => {
    const tool = makeGlobTool('node')
    const result = await tool.execute({ pattern: '**/*.ts' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.output).toContain('src/a.ts')
    expect(result.output).toContain('src/nested/b.ts')
    // The Node fallback must respect .gitignore, not just a hardcoded list.
    expect(result.output).not.toContain('generated.ts')
    expect(result.output).not.toContain('debug.log')
  })

  it('honors a simple *.ext pattern in both engines', async () => {
    for (const engine of (HAS_RG ? ['ripgrep', 'node'] : ['node']) as Array<'ripgrep' | 'node'>) {
      const tool = makeGlobTool(engine)
      const result = await tool.execute({ pattern: '*.md' }, ctx)
      expect(result.ok, engine).toBe(true)
      expect(result.output, engine).toContain('src/note.md')
    }
  })

  it('reports a clear message when nothing matches', async () => {
    const tool = makeGlobTool('node')
    const result = await tool.execute({ pattern: '**/*.doesnotexist' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.output).toMatch(/No files found/i)
  })

  it('refuses a search path that escapes the working directory', async () => {
    const tool = makeGlobTool('node')
    const result = await tool.execute({ pattern: '**/*.ts', path: '../outside' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.output).toContain('escapes the working directory')
  })

  it('caps results at the limit and says so', async () => {
    const tool = makeGlobTool('node')
    const result = await tool.execute({ pattern: '**/*.ts', limit: 1 }, ctx)
    expect(result.ok).toBe(true)
    expect(result.output).toMatch(/truncated|limit/i)
  })
})

describe('grep tool (content search)', () => {
  rgIt('finds matches with line numbers via ripgrep on every platform', async () => {
    const tool = makeGrepTool('ripgrep')
    const result = await tool.execute({ pattern: 'alpha' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.output).toContain('src/a.ts')
    expect(result.output).toMatch(/src\/a\.ts:1:/)
    // rg honors .gitignore, so the build artifact must not appear.
    expect(result.output).not.toContain('generated.ts')
  })

  it('honors .gitignore in the pure-Node fallback too', async () => {
    const tool = makeGrepTool('node')
    const result = await tool.execute({ pattern: 'alpha' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.output).toContain('src/a.ts')
    expect(result.output).not.toContain('generated.ts')
    expect(result.output).not.toContain('debug.log')
  })

  it('limits per-file matches and stays bounded', async () => {
    const tool = makeGrepTool('node')
    const result = await tool.execute({ pattern: 'alpha', path: 'src/a.ts' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.output).toContain('src/a.ts')
  })

  it('reports an invalid regex as a clear failure, not a crash', async () => {
    const tool = makeGrepTool('node')
    const result = await tool.execute({ pattern: 'a(b' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/regex/i)
  })

  rgIt('reports an invalid regex clearly under ripgrep too', async () => {
    const tool = makeGrepTool('ripgrep')
    const result = await tool.execute({ pattern: 'a(b' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/regex/i)
  })

  it('refuses a search path that escapes the working directory', async () => {
    const tool = makeGrepTool('node')
    const result = await tool.execute({ pattern: 'alpha', path: '..' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.output).toContain('escapes the working directory')
  })
})
