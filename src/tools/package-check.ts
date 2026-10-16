/**
 * Before `npm install x`, `pip install x`, `cargo add x` and the like run, ask OSV (the open vulnerability database,
 * https://osv.dev) whether the NAMED package is a known malicious one (advisory ids that start with `MAL-`). Only the
 * names typed in the command are sent, never file contents. Regular vulnerabilities are not checked here: they need a
 * version and the lock file does that better. If the network is down or slow, the command simply runs — this is a
 * seat belt, not a gate that can lock you out.
 */
export interface PackageRef {
  ecosystem: 'npm' | 'PyPI' | 'crates.io'
  name: string
}

/** Flags whose next word is a value (a file, an index URL…), not a package. */
const VALUE_FLAGS = new Set(['-r', '--requirement', '-c', '--constraint', '-e', '--editable', '-i', '--index-url', '--extra-index-url', '-f', '--find-links', '-t', '--target', '--prefix', '--registry', '--cwd', '--features', '-F'])

const NPM = /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b([^&|;\n]*)/g
const PIP = /\b(?:pip3?|python3?\s+-m\s+pip|uv\s+pip)\s+install\b([^&|;\n]*)/g
const CARGO = /\bcargo\s+(?:add|install)\b([^&|;\n]*)/g

/** The package names a command would install (flags, paths, URLs and requirement files are skipped). */
export function packagesIn(command: string): PackageRef[] {
  const out: PackageRef[] = []
  const take = (re: RegExp, ecosystem: PackageRef['ecosystem'], clean: (t: string) => string | null): void => {
    for (const m of command.matchAll(re)) {
      let skip = false
      for (const raw of m[1]!.trim().split(/\s+/)) {
        if (skip) {
          skip = false
          continue
        }
        if (VALUE_FLAGS.has(raw)) {
          skip = true
          continue
        }
        if (!raw || raw.startsWith('-') || /^(?:https?:|git[+:@]|file:|\.{0,2}[\\/]|[a-z]:\\)/i.test(raw) || raw.includes('=') && ecosystem === 'npm') continue
        const name = clean(raw)
        if (name && !out.some((p) => p.ecosystem === ecosystem && p.name === name)) out.push({ ecosystem, name })
      }
    }
  }
  take(NPM, 'npm', (t) => {
    const m = /^(@[\w.-]+\/[\w.-]+|[\w.-]+)(?:@[^/]*)?$/.exec(t)
    return m ? m[1]! : null
  })
  take(PIP, 'PyPI', (t) => {
    const m = /^([A-Za-z0-9][\w.-]*)(?:\[[^\]]*\])?(?:[=<>!~].*)?$/.exec(t)
    return m ? m[1]!.toLowerCase() : null
  })
  take(CARGO, 'crates.io', (t) => {
    const m = /^([A-Za-z0-9_-]+)(?:@.*)?$/.exec(t)
    return m ? m[1]! : null
  })
  return out.slice(0, 10)
}

export interface OsvOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/** Packages in `command` that OSV lists as malicious, with the advisory id. Never throws. */
export async function maliciousPackages(command: string, opts: OsvOptions = {}): Promise<Array<PackageRef & { advisory: string }>> {
  if (process.env['VARA_NO_PACKAGE_CHECK']) return []
  const refs = packagesIn(command)
  if (!refs.length) return []
  const doFetch = opts.fetchImpl ?? fetch
  const found: Array<PackageRef & { advisory: string }> = []
  await Promise.all(
    refs.map(async (ref) => {
      try {
        const res = await doFetch('https://api.osv.dev/v1/query', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ package: { name: ref.name, ecosystem: ref.ecosystem } }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 4000),
        })
        if (!res.ok) return
        const body = (await res.json()) as { vulns?: Array<{ id?: string }> }
        const mal = (body.vulns ?? []).find((v) => typeof v.id === 'string' && v.id.startsWith('MAL-'))
        if (mal?.id) found.push({ ...ref, advisory: mal.id })
      } catch {
        /* offline or slow: do not block */
      }
    }),
  )
  return found
}
