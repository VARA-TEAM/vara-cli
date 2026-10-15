/**
 * Pure rules for desktop control (docs/PLAN.md item 11). Nothing here touches the machine, so all of it is tested in CI.
 * Real OS control is checked by hand: scripts/desktop-smoke.ts and the checklist in docs/DEVELOPMENT.md.
 */

export interface Shot {
  /** Size of the image the model sees. */
  width: number
  height: number
  /** Real screen pixels per screenshot pixel (1 when not downscaled). */
  scale: number
}

/** Model coordinates (screenshot space) → real screen pixels, clamped to the screen. */
export function toScreen(x: number, y: number, shot: Shot): { x: number; y: number } {
  const cl = (v: number, max: number): number => Math.max(0, Math.min(max - 1, Math.round(v)))
  return { x: cl(x * shot.scale, Math.round(shot.width * shot.scale)), y: cl(y * shot.scale, Math.round(shot.height * shot.scale)) }
}

/** The size to downscale a screen to so the image stays cheap for the model (aspect ratio kept). */
export function fitSize(width: number, height: number, maxWidth = 1280): { width: number; height: number; scale: number } {
  if (width <= maxWidth) return { width, height, scale: 1 }
  const scale = width / maxWidth
  return { width: maxWidth, height: Math.round(height / scale), scale }
}

/** Windows whose title says "secrets live here": the agent does not act while one is in front. */
const SENSITIVE_TITLE = /(password|passwd|keepass|bitwarden|1password|lastpass|dashlane|credential|wallet|metamask|bank|paypal|sign in|log in|login|authenticator|security key|windows security|user account control|keychain)/i

export function isSensitiveWindow(title: string): boolean {
  return SENSITIVE_TITLE.test(title)
}

/** Key presses that would escape the sandbox of "work inside one app". */
const FORBIDDEN_KEYS = /^(ctrl\+alt\+(del|delete)|(win|meta|cmd|super)\+(l|r|x|d|e|i))$/i

export function normaliseCombo(combo: string): string {
  return combo
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/control/g, 'ctrl')
    .replace(/command|windows|super/g, 'meta')
    .replace(/return/g, 'enter')
    .replace(/esc$/g, 'escape')
}

export function keyAllowed(combo: string): { ok: boolean; reason?: string } {
  const c = normaliseCombo(combo)
  if (!c) return { ok: false, reason: 'empty key' }
  if (FORBIDDEN_KEYS.test(c)) return { ok: false, reason: `${combo} is never sent (it would leave the app the agent is working in)` }
  if (/^(alt\+f4)$/.test(c)) return { ok: false, reason: 'closing windows with alt+F4 is never sent; ask the user' }
  return { ok: true }
}

/** Text that is better pasted than typed (non-ASCII or long): SendKeys-style typing drops or garbles it. */
export function needsPaste(text: string): boolean {
  return text.length > 200 || /[^\x20-\x7e\r\n\t]/.test(text)
}

/** A budget of actions per session so a confused agent cannot click forever. */
export class ActionBudget {
  private n = 0
  private stamps: number[] = []
  constructor(
    private readonly total = 300,
    private readonly perMinute = 40,
  ) {}

  take(now = Date.now()): { ok: true } | { ok: false; reason: string } {
    this.stamps = this.stamps.filter((t) => now - t < 60_000)
    if (this.n >= this.total) return { ok: false, reason: `this session used its ${this.total} desktop actions` }
    if (this.stamps.length >= this.perMinute) return { ok: false, reason: `more than ${this.perMinute} desktop actions in a minute — slow down` }
    this.n += 1
    this.stamps.push(now)
    return { ok: true }
  }

  get used(): number {
    return this.n
  }
}

/** PNG width and height straight from the header (no image library). */
export function pngSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50) return null
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return { width: dv.getUint32(16), height: dv.getUint32(20) }
}
