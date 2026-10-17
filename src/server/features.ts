/**
 * Features a hosting operator can turn off for a whole host with `VARA_DISABLE=team,gateways,tunnel,desktop`
 * (comma separated). A hosted service uses it to keep a plan from reaching what it did not pay for, or what makes no
 * sense there. The host enforces it (the routes answer 403, the tool is not offered) and tells the web interface, which
 * hides what is off. Unknown names are ignored.
 */
export const FEATURES = ['team', 'gateways', 'tunnel', 'desktop', 'browser'] as const
export type Feature = (typeof FEATURES)[number]

/** `team`: guests, invite links, shared sessions. `gateways`: Telegram, Discord, Slack. `tunnel`: public share links. `desktop`: computer control. `browser`: the browser tool. */
export function disabledFeatures(env: NodeJS.ProcessEnv = process.env): Set<Feature> {
  const out = new Set<Feature>()
  for (const raw of String(env['VARA_DISABLE'] ?? '').split(',')) {
    const name = raw.trim().toLowerCase()
    if ((FEATURES as readonly string[]).includes(name)) out.add(name as Feature)
  }
  return out
}

/** For the web interface: true = available. */
export function featureMap(disabled: ReadonlySet<string>): Record<Feature, boolean> {
  return Object.fromEntries(FEATURES.map((f) => [f, !disabled.has(f)])) as Record<Feature, boolean>
}
