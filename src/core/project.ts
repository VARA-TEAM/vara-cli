import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Files people already keep for coding agents; the first one found is used. VARA's own name wins. */
export const INSTRUCTION_FILES = ['VARA.md', 'AGENTS.md', 'CLAUDE.md', '.vara/instructions.md']
const MAX_CHARS = 8_000

/**
 * The project's own instructions for an agent (conventions, how to build and test, things to avoid).
 * Read once when a session is created and kept with it, so the system prompt stays identical every turn
 * (provider caches depend on that). The text is DATA from the repository: it cannot widen permissions, which
 * live in the tools, and it is clearly labelled in the prompt.
 */
export function readProjectInstructions(cwd: string): { file: string; text: string } | null {
  for (const name of INSTRUCTION_FILES) {
    const path = join(cwd, name)
    try {
      if (!existsSync(path) || !statSync(path).isFile()) continue
      const raw = readFileSync(path, 'utf8').replace(/\u0000/g, '').trim()
      if (!raw) continue
      const text = raw.length > MAX_CHARS ? `${raw.slice(0, MAX_CHARS)}\n…(truncated: ${raw.length - MAX_CHARS} more characters)` : raw
      return { file: name, text }
    } catch {
      /* unreadable: try the next one */
    }
  }
  return null
}

/**
 * A verify command for the project, from what is in the folder. Returns undefined when it cannot tell — never a guess.
 * (docs/ROADMAP.md R2.)
 */
export function detectVerifyCommand(cwd: string): string | undefined {
  const has = (f: string): boolean => existsSync(join(cwd, f))
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
      const t = pkg.scripts?.['test']
      if (t && !/no test specified/i.test(t)) return has('pnpm-lock.yaml') ? 'pnpm test' : has('yarn.lock') ? 'yarn test' : has('bun.lockb') ? 'bun test' : 'npm test'
    } catch {
      /* a broken package.json: fall through */
    }
  }
  if (has('Cargo.toml')) return 'cargo test'
  if (has('go.mod')) return 'go test ./...'
  if (has('pytest.ini') || has('tox.ini') || (has('pyproject.toml') && /\[tool\.pytest/.test(safeRead(join(cwd, 'pyproject.toml'))))) return 'pytest'
  return undefined
}

function safeRead(p: string): string {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}
