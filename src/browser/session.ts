import type { Transport } from './cdp.js'
import { isRiskyControl, isSecretField, OriginPolicy } from './policy.js'

export interface PageElement {
  id: number
  tag: string
  type?: string
  name?: string
  label: string
  href?: string
  value?: string
  secret: boolean
  risky: boolean
}

export interface Snapshot {
  url: string
  title: string
  text: string
  elements: PageElement[]
}

/** Runs inside the page: numbers the interactive elements and returns what a person could see and click. */
const SNAPSHOT_JS = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=checkbox],[role=tab],[onclick],summary';
  const out = []; let n = 0;
  document.querySelectorAll('[data-vara-id]').forEach((e) => e.removeAttribute('data-vara-id'));
  for (const e of document.querySelectorAll(sel)) {
    if (!vis(e) || n >= 120) continue;
    n += 1; e.setAttribute('data-vara-id', String(n));
    const label = (e.getAttribute('aria-label') || e.innerText || e.value || e.placeholder || e.title || e.alt || '').trim().replace(/\\s+/g, ' ').slice(0, 90);
    const lab = e.id ? document.querySelector('label[for="' + CSS.escape(e.id) + '"]') : null;
    out.push({ id: n, tag: e.tagName.toLowerCase(), type: e.type || undefined, name: e.name || undefined, autocomplete: e.autocomplete || undefined,
      label: label || (lab ? lab.innerText.trim().slice(0, 90) : ''), href: e.href || undefined, value: (e.type === 'password' ? '' : (e.value || '')).toString().slice(0, 60) || undefined });
  }
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 6000);
  return { url: location.href, title: document.title, text, elements: out };
})()`

/**
 * One browser tab driven over CDP. Every network request the page makes is checked against the origin policy
 * (so a page cannot send data to a host nobody approved), downloads are refused, and the agent never types into
 * password or payment fields.
 */
export class BrowserSession {
  private sessionId = ''
  private blocked: string[] = []
  private offs: Array<() => void> = []

  constructor(
    private readonly cdp: Transport,
    readonly policy: OriginPolicy,
  ) {}

  /** What was blocked since the last call (shown to the model so it can explain a half-loaded page). */
  takeBlocked(): string[] {
    const b = this.blocked
    this.blocked = []
    return [...new Set(b)].slice(0, 8)
  }

  async open(): Promise<void> {
    const { targetId } = (await this.cdp.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string }
    const att = (await this.cdp.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string }
    this.sessionId = att.sessionId
    const s = (m: string, p: Record<string, unknown> = {}) => this.cdp.send(m, p, this.sessionId)
    await s('Page.enable')
    await s('Runtime.enable')
    await this.cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {})
    await s('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
    this.offs.push(
      this.cdp.on('Fetch.requestPaused', (p) => {
        const url = String(p['request'] && (p['request'] as { url?: string }).url)
        const requestId = String(p['requestId'])
        const v = url.startsWith('data:') || url.startsWith('blob:') ? { kind: 'allow' as const } : this.policy.check(url, true)
        if (v.kind === 'allow') void s('Fetch.continueRequest', { requestId }).catch(() => {})
        else {
          this.blocked.push(v.kind === 'deny' ? v.reason : url)
          void s('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {})
        }
      }),
    )
  }

  private async s(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.cdp.send(method, params, this.sessionId)
  }

  private async evaluate<T>(expression: string): Promise<T> {
    const r = (await this.s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })) as {
      result?: { value?: T }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'script error')
    return r.result?.value as T
  }

  async navigate(url: string): Promise<void> {
    const loaded = new Promise<void>((resolve) => {
      const off = this.cdp.on('Page.loadEventFired', () => (off(), resolve()))
      setTimeout(() => (off(), resolve()), 15_000)
    })
    const r = (await this.s('Page.navigate', { url })) as { errorText?: string }
    if (r.errorText) throw new Error(`could not load the page: ${r.errorText}`)
    await loaded
  }

  async snapshot(): Promise<Snapshot> {
    const raw = await this.evaluate<{ url: string; title: string; text: string; elements: Array<Omit<PageElement, 'secret' | 'risky'> & { autocomplete?: string }> }>(SNAPSHOT_JS)
    return {
      url: raw.url,
      title: raw.title,
      text: raw.text,
      elements: raw.elements.map((e) => ({
        id: e.id,
        tag: e.tag,
        ...(e.type ? { type: e.type } : {}),
        ...(e.name ? { name: e.name } : {}),
        label: e.label,
        ...(e.href ? { href: e.href } : {}),
        ...(e.value ? { value: e.value } : {}),
        secret: isSecretField({ type: e.type, name: e.name, autocomplete: e.autocomplete, label: e.label }),
        risky: (e.tag === 'button' || e.type === 'submit' || e.tag === 'a' || e.type === 'button') && isRiskyControl(e.label),
      })),
    }
  }

  async element(id: number): Promise<PageElement | null> {
    const snap = await this.snapshot()
    return snap.elements.find((e) => e.id === id) ?? null
  }

  private async centre(id: number): Promise<{ x: number; y: number }> {
    const r = await this.evaluate<{ x: number; y: number } | null>(
      `(() => { const e = document.querySelector('[data-vara-id="${Math.trunc(id)}"]'); if (!e) return null; e.scrollIntoView({ block: 'center', inline: 'center' }); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
    )
    if (!r) throw new Error(`element ${id} is no longer on the page — take a new snapshot`)
    return r
  }

  async click(id: number): Promise<void> {
    const { x, y } = await this.centre(id)
    for (const type of ['mousePressed', 'mouseReleased'] as const) await this.s('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
    await new Promise((r) => setTimeout(r, 400))
  }

  async type(id: number, text: string, clear = true): Promise<void> {
    await this.evaluate(
      `(() => { const e = document.querySelector('[data-vara-id="${Math.trunc(id)}"]'); if (!e) throw new Error('element not found'); e.focus(); ${clear ? "if ('select' in e) e.select();" : ''} return true; })()`,
    )
    await this.s('Input.insertText', { text })
  }

  async press(key: 'Enter' | 'Tab' | 'Escape' | 'ArrowDown' | 'ArrowUp' | 'Backspace'): Promise<void> {
    const code = { Enter: 13, Tab: 9, Escape: 27, ArrowDown: 40, ArrowUp: 38, Backspace: 8 }[key]
    for (const type of ['keyDown', 'keyUp'] as const) await this.s('Input.dispatchKeyEvent', { type, key, windowsVirtualKeyCode: code, ...(key === 'Enter' && type === 'keyDown' ? { text: '\r' } : {}) })
    await new Promise((r) => setTimeout(r, 400))
  }

  async screenshot(): Promise<Buffer> {
    const r = (await this.s('Page.captureScreenshot', { format: 'png' })) as { data: string }
    return Buffer.from(r.data, 'base64')
  }

  async back(): Promise<void> {
    await this.evaluate('history.back()')
    await new Promise((r) => setTimeout(r, 500))
  }

  async currentUrl(): Promise<string> {
    return this.evaluate<string>('location.href')
  }

  async close(): Promise<void> {
    for (const off of this.offs) off()
    this.offs = []
    this.cdp.close()
  }
}
