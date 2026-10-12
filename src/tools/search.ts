import { z } from 'zod'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { Tool, ToolResult } from './types.js'

/**
 * Search tools: `glob` (path search) and an upgraded `grep` (content search).
 *
 * Both are backed by a swappable engine:
 *   - 'ripgrep' — spawns `rg`, which honors .gitignore natively and is fast.
 *   - 'node'    — a pure-Node walker that ALSO honors .gitignore, used when
 *                 rg is unavailable and as a deterministic path in tests.
 *
 * Design note (VARA, not OpenCode): the upstream reference wraps this in a
 * heavy Effect/service layer. Here the engine is a plain injectable string so
 * tests can exercise both paths without forking processes or loading bun.
 */

export type SearchEngine = 'ripgrep' | 'node'

const DEFAULT_GLOB_LIMIT = 200
const DEFAULT_GREP_MATCHES = 200
const GREP_MAX_PER_FILE = 5
const MAX_LINE_CHARS = 300
const MAX_OUTPUT_CHARS = 50_000

/* ---------- .gitignore-aware matching (used by the Node engine) ---------- */

interface IgnoreRule {
  negate: boolean
  dirOnly: boolean
  anchored: boolean
  /** Glob body with anchors already stripped. */
  pattern: string
  /** Repo-root-relative prefix of the .gitignore that declared this rule. */
  base: string
}

/** Convert a gitignore/glob body to a regex source, honoring ** and ?. */
function globToRegexSource(pat: string): string {
  let out = ''
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]!
    if (c === '*') {
      if (pat[i + 1] === '*') {
        i++
        if (pat[i + 1] === '/') {
          i++
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      out += '\\' + c
    } else {
      out += c
    }
  }
  return out
}

function parseIgnoreFile(content: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (!line || line.startsWith('#')) continue
    let negate = false
    let body = line
    if (body.startsWith('!')) {
      negate = true
      body = body.slice(1)
    }
    let dirOnly = false
    if (body.endsWith('/')) {
      dirOnly = true
      body = body.slice(0, -1)
    }
    let anchored = false
    if (body.startsWith('/')) {
      anchored = true
      body = body.slice(1)
    } else if (body.includes('/')) {
      anchored = true
    }
    if (!body) continue
    rules.push({ negate, dirOnly, anchored, pattern: body, base })
  }
  return rules
}

function ruleMatches(rule: IgnoreRule, relPath: string, isDir: boolean): boolean {
  if (rule.dirOnly && !isDir) return false
  if (rule.anchored) {
    let subject: string
    if (rule.base) {
      if (!relPath.startsWith(rule.base + '/')) return false
      subject = relPath.slice(rule.base.length + 1)
    } else {
      subject = relPath
    }
    return new RegExp(`^${globToRegexSource(rule.pattern)}$`).test(subject)
  }
  // Unanchored patterns match a basename at any depth.
  const segs = relPath.split('/')
  const baseName = segs[segs.length - 1]!
  return new RegExp(`^${globToRegexSource(rule.pattern)}$`).test(baseName)
}

/** Last matching rule wins; deeper .gitignore files append later. */
function isIgnored(relPath: string, isDir: boolean, rules: readonly IgnoreRule[]): boolean {
  let ignored = false
  for (const rule of rules) {
    if (ruleMatches(rule, relPath, isDir)) ignored = !rule.negate
  }
  return ignored
}

/* ---------- ripgrep detection ---------- */

let rgCache: SearchEngine | null = null

/** Detect rg once; cached. Exposed so tests can force a path via make*Tool. */
export async function detectEngine(): Promise<SearchEngine> {
  if (rgCache) return rgCache
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    await promisify(execFile)('rg', ['--version'], { windowsHide: true })
    rgCache = 'ripgrep'
  } catch {
    rgCache = 'node'
  }
  return rgCache
}

async function runRg(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  try {
    const run = promisify(execFile)
    const { stdout } = await run('rg', args, {
      cwd,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

/** rg prints Windows paths with backslashes and a `.\` prefix; normalize to
 *  forward-slash, root-relative paths so output is stable across platforms. */
function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
}

/* ---------- path safety (same contract as fs-tools) ---------- */

function resolveInside(cwd: string, p: string): { path: string; rel: string } | { error: string } {
  const abs = resolve(cwd, p)
  const rel = relative(cwd, abs)
  if (rel.startsWith('..')) {
    return { error: `Path escapes the working directory: ${p}` }
  }
  // Normalize to forward slashes so all reported paths are platform-stable.
  return { path: abs, rel: (rel || '.').replace(/\\/g, '/') }
}

/* ---------- shared .gitignore-respecting walker (Node engine) ---------- */

async function walkFiles(
  root: string,
  opts: { maxDepth?: number; includeHidden?: boolean; stopAfter?: (count: number) => boolean },
): Promise<string[]> {
  const out: string[] = []
  const maxDepth = opts.maxDepth ?? 12

  async function walk(dir: string, depth: number, parentRules: readonly IgnoreRule[]): Promise<void> {
    if (depth > maxDepth) return
    let rules = parentRules
    try {
      const gi = await readFile(join(dir, '.gitignore'), 'utf8')
      const baseRel = relative(root, dir).replace(/\\/g, '/')
      const parsed = parseIgnoreFile(gi, baseRel === '' ? '' : baseRel)
      if (parsed.length) rules = [...parentRules, ...parsed]
    } catch {
      /* no .gitignore here */
    }

    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = (relative(root, join(dir, entry.name)) || entry.name).replace(/\\/g, '/')
      const isHidden = entry.name.startsWith('.')
      if (isHidden && !opts.includeHidden) continue
      if (isIgnored(rel, entry.isDirectory(), rules)) continue
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), depth + 1, rules)
      } else if (entry.isFile()) {
        out.push(rel)
        if (opts.stopAfter?.(out.length)) return
      }
    }
  }

  await walk(root, 0, [])
  return out
}

/** Translate a user glob to a matcher over repo-relative '/' paths. */
function makeGlobMatcher(pattern: string): (relPath: string) => boolean {
  const anchored = pattern.includes('/')
  const src = globToRegexSource(pattern)
  if (anchored) {
    const re = new RegExp(`^${src}$`)
    return (p) => re.test(p)
  }
  const re = new RegExp(`(^|/)${src}$`)
  return (p) => re.test(p)
}

/* ---------- glob tool ---------- */

const globSchema = z
  .object({
    pattern: z.string().describe('Glob pattern to match files against (e.g. "**/*.ts", "src/**/*.tsx", "*.md")'),
    path: z.string().optional().describe('Directory to search. Defaults to the working directory.'),
    hidden: z.boolean().optional().describe('Include hidden files and directories (default: false).'),
    limit: z.number().int().min(1).max(2000).optional().describe(`Maximum results (default: ${DEFAULT_GLOB_LIMIT}).`),
  })
  .describe('Search file paths using a glob pattern')

export function makeGlobTool(engine?: SearchEngine): Tool<z.infer<typeof globSchema>> {
  return {
    name: 'glob',
    description:
      'Search file paths using a glob pattern (examples: "**/*.ts", "src/**/*.tsx"). ' +
      'Honors .gitignore. Returns matching paths, one per line.',
    readonly: true,
    schema: globSchema,
    async execute(args, ctx): Promise<ToolResult> {
      const target = resolveInside(ctx.cwd, args.path ?? '.')
      if ('error' in target) return { ok: false, output: target.error }
      const limit = args.limit ?? DEFAULT_GLOB_LIMIT
      const use = engine ?? (await detectEngine())

      try {
        const info = await stat(target.path)
        if (!info.isDirectory()) return { ok: false, output: `Search path is not a directory: ${args.path ?? '.'}` }
      } catch {
        return { ok: false, output: `Search path does not exist: ${args.path ?? '.'}` }
      }

      let matches: string[]
      if (use === 'ripgrep') {
        const rgArgs = [
          '--no-config',
          '--no-require-git',
          '--files',
          ...(args.hidden ? ['--hidden'] : []),
          `--glob=${args.pattern}`,
          ...(args.hidden ? [] : ['--glob=!**/.*']),
          '--glob=!**/.git/**',
          '.',
        ]
        const res = await runRg(rgArgs, target.path)
        if (res.code === 2 && /regex parse error|error parsing glob/i.test(res.stderr)) {
          return { ok: false, output: `Invalid glob pattern: ${res.stderr.trim()}` }
        }
        matches = res.stdout.split(/\r?\n/).filter(Boolean).map(normalizeRel)
      } else {
        const matcher = makeGlobMatcher(args.pattern)
        const all = await walkFiles(target.path, { includeHidden: args.hidden, stopAfter: (n) => n > limit })
        matches = all.filter(matcher)
      }

      const truncated = matches.length > limit
      const shown = matches.slice(0, limit)
      const lines = shown.length === 0 ? ['No files found'] : shown.map((p) => (target.rel === '.' ? p : `${target.rel}/${p}`))
      if (truncated) lines.push('', `(Results truncated at ${limit}. Use a more specific path or pattern.)`)
      return { ok: true, output: lines.join('\n').slice(0, MAX_OUTPUT_CHARS) }
    },
  }
}

export const globTool = makeGlobTool()

/* ---------- grep tool ---------- */

const grepSchema = z
  .object({
    pattern: z.string().describe('Regular expression to search for'),
    path: z.string().optional().describe('Directory or file to search. Default "."'),
    literal: z.boolean().optional().describe('Treat the pattern as a fixed string, not a regex.'),
    caseSensitive: z.boolean().optional().describe('Case-sensitive search (default: true).'),
  })
  .describe('Search file contents with a regular expression')

export function makeGrepTool(engine?: SearchEngine): Tool<z.infer<typeof grepSchema>> {
  return {
    name: 'grep',
    description:
      'Search file contents with a regular expression inside the working directory. ' +
      'Honors .gitignore. Returns path:line:content matches.',
    readonly: true,
    schema: grepSchema,
    async execute(args, ctx): Promise<ToolResult> {
      const target = resolveInside(ctx.cwd, args.path ?? '.')
      if ('error' in target) return { ok: false, output: target.error }
      const use = engine ?? (await detectEngine())

      if (use === 'ripgrep') {
        const rgArgs = [
          '--no-config',
          '--no-require-git',
          '--json',
          '--no-messages',
          ...(args.literal ? ['--fixed-strings'] : []),
          ...(args.caseSensitive === false ? ['--ignore-case'] : []),
          '--glob=!**/.git/**',
          '--',
          args.pattern,
          '.',
        ]
        const res = await runRg(rgArgs, target.path)
        if (res.code === 2 && /regex parse error|error parsing regex/i.test(res.stderr)) {
          return { ok: false, output: `Invalid regex: ${res.stderr.trim()}` }
        }
        const hits: string[] = []
        for (const line of res.stdout.split(/\r?\n/)) {
          if (!line) continue
          try {
            const json = JSON.parse(line) as { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } }
            if (json.type !== 'match' || !json.data) continue
            const p = normalizeRel(json.data.path?.text ?? '')
            const n = json.data.line_number ?? 0
            const text = (json.data.lines?.text ?? '').trim().slice(0, MAX_LINE_CHARS)
            const rel = target.rel === '.' ? p : `${target.rel}/${p}`
            hits.push(`${rel}:${n}:${text}`)
            if (hits.length >= DEFAULT_GREP_MATCHES) break
          } catch {
            /* skip malformed JSON line */
          }
        }
        return { ok: true, output: hits.join('\n').slice(0, MAX_OUTPUT_CHARS) || 'No matches.' }
      }

      // Node engine
      let re: RegExp
      try {
        re = new RegExp(args.pattern, args.caseSensitive === false ? 'i' : '')
      } catch (err) {
        return { ok: false, output: `Invalid regex: ${(err as Error).message}` }
      }

      let files: string[]
      let baseDir: string
      let singleFile = false
      try {
        const info = await stat(target.path)
        if (info.isFile()) {
          // rel already IS the full path from cwd; do not prefix it again.
          files = [target.rel]
          baseDir = ctx.cwd
          singleFile = true
        } else {
          files = await walkFiles(target.path, { stopAfter: (n) => n > 2000 })
          baseDir = target.path
        }
      } catch {
        return { ok: false, output: `Search path does not exist: ${args.path ?? '.'}` }
      }

      const hits: string[] = []
      for (const rel of files) {
        const abs = join(baseDir, rel)
        let content: string
        try {
          content = await readFile(abs, 'utf8')
        } catch {
          continue /* binary or unreadable */
        }
        let perFile = 0
        content.split(/\r?\n/).forEach((line, i) => {
          if (perFile >= GREP_MAX_PER_FILE || hits.length >= DEFAULT_GREP_MATCHES) return
          if (args.literal ? line.includes(args.pattern) : re.test(line)) {
            perFile++
            const shownRel = singleFile || target.rel === '.' ? rel : `${target.rel}/${rel}`
            hits.push(`${shownRel}:${i + 1}:${line.trim().slice(0, MAX_LINE_CHARS)}`)
          }
        })
        if (hits.length >= DEFAULT_GREP_MATCHES) break
      }
      return { ok: true, output: hits.join('\n').slice(0, MAX_OUTPUT_CHARS) || 'No matches.' }
    },
  }
}

export const grepTool = makeGrepTool()
