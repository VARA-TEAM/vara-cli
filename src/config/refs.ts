/**
 * Guards that config fields meant to hold a NAME (of a secret, an env var)
 * actually hold a name — and never a leaked key VALUE.
 *
 * Why this exists: `apiKeySecret` / `apiKeyEnv` are interpolated into the
 * "No API key found" error and read as lookup keys. If a user pastes an actual
 * key into one of them, that key would be printed to the terminal, written to
 * logs, and used as a (nonexistent) lookup name. This is a pure function with
 * no module state, so it is safe to import statically anywhere.
 */

/**
 * A config reference is a NAME: letters, digits, underscore or dot, starting
 * with a letter/underscore. No whitespace, no leading dash.
 *
 * The denylist below also rejects well-known key prefixes (sk-, ghp_, …) so a
 * pasted secret is refused even if it happens to look name-ish.
 */
const KNOWN_KEY_PREFIXES = /^(sk-|sk_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|AKIA|ASIA|Bearer\s|AIza|xox[baprs]-|glpat-|npm_|dop_|hf_)/

export function configRef(value: string): boolean {
  if (value === '') return true
  if (KNOWN_KEY_PREFIXES.test(value)) return false
  // Reject anything with whitespace or a leading dash; require name shape.
  if (/\s/.test(value) || value.startsWith('-')) return false
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value)
}

/** Human-readable explanation, reused by the schema and the runtime guard. */
export const CONFIG_REF_EXPECTATION =
  'must be the NAME of a secret/variable (e.g. KTAI_API_KEY) — never a key value itself'

/**
 * Throws if `value` is not a valid config reference. Used by `buildProvider` as
 * a defense-in-depth guard (the schema already validates on load; this catches
 * programmatic construction that bypasses parsing).
 */
export function assertConfigRef(field: string, value: string): void {
  if (!configRef(value)) {
    throw new Error(`Invalid provider config: ${field} ${CONFIG_REF_EXPECTATION}.`)
  }
}
