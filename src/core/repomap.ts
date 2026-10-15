import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'

/**
 * Repo map: a ranked outline of the project's symbols, so the model can find
 * where things live WITHOUT reading whole files (idea: Aider's repo map — see
 * docs/COST.md for sources). No parser dependency: a small per-language regex
 * extractor finds definitions; ranking counts how many OTHER files mention each
 * symbol name (a cheap stand-in for Aider's PageRank over a reference graph).
 * It is an index for navigation, not a compiler: it can miss exotic syntax,
 * and says so rather than pretending to be exact.
 */

export interface Sym {
  name: string
  kind: string
  line: number
  endLine: number
  sig: string
}
export interface FileIndex {
  path: string
  lines: number
  syms: Sym[]
  words: Set<string>
}
export interface RepoIndex {
  root: string
  files: FileIndex[]
  builtAt: number
  truncated: boolean
}

const IGNORED = new Set(['node_modules', '.git', 'dist', '.next', '.turbo', '.cache', 'coverage', 'build', 'out', '.vscode', '.idea', '__pycache__', '.pytest_cache', 'target', 'vendor', '.venv', 'venv', 'release', '.worktrees'])
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.cs', '.rb', '.php', '.c', '.h', '.cc', '.cpp', '.hpp', '.swift'])
const MAX_FILES = 2500
const MAX_BYTES = 250_000

type Rule = { re: RegExp; kind: string; name: number }

const JS: Rule[] = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function', name: 1 },
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class', name: 1 },
  { re: /^\s*(?:export\s+)?(?:interface)\s+([A-Za-z_$][\w$]*)/, kind: 'interface', name: 1 },
  { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/, kind: 'type', name: 1 },
  { re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum', name: 1 },
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, kind: 'function', name: 1 },
  { re: /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]{2,})\s*[:=]/, kind: 'const', name: 1 },
  // class methods (indented, with a body or an arrow)
  { re: /^\s{2,}(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)\s*(?::\s*[^{;=]+)?\s*\{\s*$/, kind: 'method', name: 1 },
]
const PY: Rule[] = [
  { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'function', name: 1 },
  { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: 'class', name: 1 },
]
const GO: Rule[] = [
  { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: 'func', name: 1 },
  { re: /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, kind: 'type', name: 1 },
]
const RUST: Rule[] = [
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'fn', name: 1 },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/, kind: 'type', name: 1 },
  { re: /^\s*impl(?:<[^>]*>)?\s+(?:[A-Za-z_]\w*\s+for\s+)?([A-Za-z_]\w*)/, kind: 'impl', name: 1 },
]
const JAVA: Rule[] = [
  { re: /^\s*(?:public|private|protected|internal|static|final|abstract|sealed|data|open|\s)*\s*(?:class|interface|enum|record|object)\s+([A-Za-z_]\w*)/, kind: 'class', name: 1 },
  { re: /^\s+(?:public|private|protected|static|final|abstract|override|suspend|\s)+[\w<>\[\], ?]+\s+([a-z_]\w*)\s*\([^;]*\)\s*(?:throws [\w, ]+)?\s*\{\s*$/, kind: 'method', name: 1 },
]

function rulesFor(ext: string): Rule[] {
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return JS
  if (ext === '.py') return PY
  if (ext === '.go') return GO
  if (ext === '.rs') return RUST
  return JAVA
}

/** Line (1-based) where the block starting at `start` ends — by braces, or by indentation for Python. */
function blockEnd(lines: string[], start: number, ext: string): number {
  if (ext === '.py') {
    const indent = /^\s*/.exec(lines[start - 1]!)![0].length
    let last = start
    for (let i = start; i < lines.length; i++) {
      const l = lines[i]!
      if (l.trim() === '') continue
      const ind = /^\s*/.exec(l)![0].length
      if (ind <= indent) break
      last = i + 1
    }
    return last
  }
  let depth = 0
  let opened = false
  for (let i = start - 1; i < Math.min(lines.length, start + 600); i++) {
    const l = lines[i]!.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '')
    for (const ch of l) {
      if (ch === '{') {
        depth++
        opened = true
      } else if (ch === '}') depth--
    }
    if (opened && depth <= 0) return i + 1
    if (!opened && i > start && /;\s*$/.test(l)) return i + 1 // one-liner type/const
  }
  return Math.min(lines.length, start)
}

const WORD = /[A-Za-z_$][\w$]{2,}/g

export function indexFile(path: string, text: string): FileIndex {
  const ext = extname(path).toLowerCase()
  const lines = text.split(/\r?\n/)
  const rules = rulesFor(ext)
  const syms: Sym[] = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    if (l.length > 300) continue
    for (const r of rules) {
      const m = r.re.exec(l)
      if (m?.[r.name]) {
        const name = m[r.name]!
        if (['if', 'for', 'while', 'switch', 'catch', 'return', 'constructor', 'function'].includes(name)) break
        syms.push({ name, kind: r.kind, line: i + 1, endLine: blockEnd(lines, i + 1, ext), sig: l.trim().replace(/\s*\{\s*$/, '').slice(0, 120) })
        break
      }
    }
  }
  const words = new Set<string>()
  for (const m of text.matchAll(WORD)) words.add(m[0])
  return { path, lines: lines.length, syms, words }
}

async function walk(root: string, dir: string, out: string[]): Promise<boolean> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return false
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const e of entries) {
    if (out.length >= MAX_FILES) return true
    if (e.name.startsWith('.') && e.name !== '.') {
      if (IGNORED.has(e.name) || e.isDirectory()) continue
    }
    if (IGNORED.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (await walk(root, p, out)) return true
    } else if (CODE_EXT.has(extname(e.name).toLowerCase())) out.push(p)
  }
  return false
}

const cache = new Map<string, RepoIndex>()
const TTL_MS = 60_000

export function invalidateRepoMap(root?: string): void {
  if (root) cache.delete(root)
  else cache.clear()
}

export async function buildIndex(root: string, force = false): Promise<RepoIndex> {
  const hit = cache.get(root)
  if (!force && hit && Date.now() - hit.builtAt < TTL_MS) return hit
  const paths: string[] = []
  const truncated = await walk(root, root, paths)
  const files: FileIndex[] = []
  for (const p of paths) {
    try {
      const st = await stat(p)
      if (st.size > MAX_BYTES) continue
      files.push(indexFile(relative(root, p).split('\\').join('/'), await readFile(p, 'utf8')))
    } catch {
      /* unreadable: skip */
    }
  }
  const idx: RepoIndex = { root, files, builtAt: Date.now(), truncated }
  cache.set(root, idx)
  return idx
}

export interface RankedFile {
  file: FileIndex
  score: number
}

/** Rank files by how much the rest of the project leans on their symbols, plus how well they match the query. */
export function rankFiles(idx: RepoIndex, query = ''): RankedFile[] {
  const terms = query.toLowerCase().split(/[^a-z0-9_$]+/).filter((t) => t.length >= 2)
  // How many OTHER files mention each symbol name.
  const mentions = new Map<string, number>()
  for (const f of idx.files) for (const s of f.syms) mentions.set(s.name, 0)
  for (const f of idx.files) for (const w of f.words) if (mentions.has(w)) mentions.set(w, (mentions.get(w) ?? 0) + 1)
  return idx.files
    .map((file) => {
      let score = 0
      for (const s of file.syms) score += Math.log1p(Math.max(0, (mentions.get(s.name) ?? 1) - 1))
      const lowerPath = file.path.toLowerCase()
      for (const t of terms) {
        if (lowerPath.includes(t)) score += 6
        for (const s of file.syms) if (s.name.toLowerCase().includes(t)) score += 4
      }
      return { file, score }
    })
    .filter((r) => r.file.syms.length > 0)
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
}

/** Render within a token budget (≈ 4 chars per token). */
export function renderMap(idx: RepoIndex, opts: { query?: string; path?: string; budgetTokens?: number } = {}): string {
  const budget = Math.max(200, Math.min(opts.budgetTokens ?? 1500, 6000)) * 4
  const prefix = opts.path ? opts.path.replace(/^\.?\//, '').replace(/\\/g, '/') : ''
  const sub: RepoIndex = prefix ? { ...idx, files: idx.files.filter((f) => f.path.startsWith(prefix)) } : idx
  const ranked = rankFiles(sub, opts.query)
  const out: string[] = []
  let used = 0
  let shown = 0
  for (const { file } of ranked) {
    const head = `${file.path} (${file.lines} lines)`
    const body: string[] = []
    const queryTerms = (opts.query ?? '').toLowerCase().split(/[^a-z0-9_$]+/).filter((t) => t.length >= 2)
    const wanted = file.syms.filter((s) => s.kind !== 'method' || queryTerms.some((t) => s.name.toLowerCase().includes(t)))
    for (const s of wanted.slice(0, 40)) body.push(`  ${s.line}-${s.endLine} ${s.sig}`)
    const block = `${head}\n${body.join('\n')}\n`
    if (used + block.length > budget && shown > 0) break
    out.push(block)
    used += block.length
    shown++
  }
  const note = `[repo map: ${shown} of ${sub.files.filter((f) => f.syms.length).length} files with symbols, ranked by use across the project${opts.query ? ` and match to "${opts.query}"` : ''}; line ranges are start-end. Read a slice with read_file offset/limit, or one symbol with read_symbol.${idx.truncated ? ' Index capped at ' + MAX_FILES + ' files.' : ''}]`
  return `${note}\n${out.join('')}`.trimEnd()
}

/** Find definitions by name; exact matches first. */
export function findSymbols(idx: RepoIndex, name: string, path?: string): Array<{ file: string; sym: Sym }> {
  const exact: Array<{ file: string; sym: Sym }> = []
  const loose: Array<{ file: string; sym: Sym }> = []
  const prefix = path ? path.replace(/^\.?\//, '').replace(/\\/g, '/') : ''
  for (const f of idx.files) {
    if (prefix && !f.path.startsWith(prefix)) continue
    for (const s of f.syms) {
      if (s.name === name) exact.push({ file: f.path, sym: s })
      else if (s.name.toLowerCase() === name.toLowerCase()) loose.push({ file: f.path, sym: s })
    }
  }
  return exact.length ? exact : loose
}

/** A compact outline of ONE file (used when a big file is read without a range). */
export function outlineOf(path: string, text: string, max = 80): string {
  const fi = indexFile(path, text)
  return fi.syms
    .filter((s) => s.kind !== 'method' || fi.syms.length <= max)
    .slice(0, max)
    .map((s) => `  ${s.line}-${s.endLine} ${s.sig}`)
    .join('\n')
}
