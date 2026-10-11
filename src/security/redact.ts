/**
 * Redaction: keeps secret values out of transcripts, event logs and TUI output.
 *
 * Register every secret that is in scope for a session; every string the engine
 * stores or displays passes through scrub() first.
 */

const registered = new Map<string, string>() // value -> label
const MIN_SECRET_LENGTH = 6

export function registerSecret(value: string, label: string): void {
  if (!value || value.length < MIN_SECRET_LENGTH) return
  registered.set(value, label)
}

export function clearSecrets(): void {
  registered.clear()
}

export function scrub(input: string): string {
  if (!input) return input
  let out = input
  for (const [value, label] of registered) {
    if (out.includes(value)) {
      out = out.split(value).join(`⟦${label}⟧`)
    }
    // Also catch URL-embedded credentials: scheme://user:pass@host
    try {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      out = out.replace(new RegExp(`://${escaped}`, 'g'), `://⟦${label}⟧`)
    } catch {
      /* regex construction should never fail for escaped literals */
    }
  }
  return out
}

/** Common credential shapes the model or tools may echo without us registering them. */
const PATTERNS: Array<[RegExp, string]> = [
  [/ghp_[A-Za-z0-9]{20,}/g, 'github-token'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, 'github-token'],
  [/sk-[A-Za-z0-9_-]{20,}/g, 'api-key'],
  [/AKIA[0-9A-Z]{16}/g, 'aws-key'],
  [/Bearer\s+[A-Za-z0-9._-]{20,}/g, 'bearer-token'],
]

export function scrubPatterns(input: string): string {
  let out = input
  for (const [re, label] of PATTERNS) out = out.replace(re, `⟦${label}⟧`)
  return out
}

/** Full scrub used by the engine before anything is persisted or rendered. */
export function scrubAll(input: string): string {
  return scrubPatterns(scrub(input))
}
