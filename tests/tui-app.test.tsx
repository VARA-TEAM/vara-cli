import React from 'react'
import { render, cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Provider, ProviderRequest, ProviderEvent, AssistantTurn } from '../src/llm/provider.js'
import { DEFAULT_CONFIG, type VaraConfig } from '../src/config/config.js'
import { App } from '../src/tui/App.js'
import { applyTheme, theme } from '../src/tui/theme.js'

/**
 * Component-level regression tests for the TUI — the layer where the incident
 * actually happened (unit tests stayed green the whole time). Keys are fed the
 * way a terminal delivers them: a lone "\r" is Enter, a multi-character chunk
 * is a paste.
 */

const ENTER = '\r'
const ESC = '\x1b'
const TAB = '\t'
const CTRL_K = '\x0b'
const CTRL_N = '\x0e'
const CTRL_W = '\x17'
const CTRL_G = '\x07'
const CTRL_O = '\x0f'
const RIGHT = '\x1b[C'

afterEach(() => {
  cleanup()
  applyTheme('vara')
})

const settle = () => new Promise((r) => setTimeout(r, 70))

/** Scripted provider: yields scripted turns in order. When the script runs
 * out it "thinks" forever and never answers — the engine then stays running
 * until the session is paused or its tab is closed (as with a stuck model).
 * The freeze is deliberate: no abort can unpick it, so a closed tab can
 * never leak events into the restored session (the exact R7 regression). */
class FakeProvider implements Provider {
  id = 'openai' as const
  constructor(private readonly script: AssistantTurn[]) {}
  async *chat(_req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const turn = this.script.shift()
    if (!turn) {
      yield { type: 'text', delta: 'thinking…' }
      await new Promise<void>(() => {})
      return
    }
    if (turn.content) yield { type: 'text', delta: turn.content }
    yield { type: 'done', result: turn }
  }
}

const testConfig: VaraConfig = {
  ...DEFAULT_CONFIG,
  provider: { ...DEFAULT_CONFIG.provider, model: 'test-model' },
  defaultVerifyCommand: 'node -e "process.exit(0)"',
}

const completeTurn: AssistantTurn = {
  content: 'Everything is in place.',
  toolCalls: [
    {
      id: 'c1',
      name: 'complete',
      arguments: JSON.stringify({ summary: 'Done', verificationPlan: 'node exit 0', verifiedRequirements: ['1'] }),
    },
  ],
}

async function renderHome(provider: Provider, config: VaraConfig = testConfig) {
  const instance = render(<App session={null} provider={provider} config={config} autoStart={false} />)
  await vi.waitFor(() => expect(instance.lastFrame()).toContain('Enter send'))
  // The first frame renders before React's passive effects run — and ink
  // attaches its stdin 'readable' listener inside an effect. Writing keys
  // before that silently drops them, so let effects flush first.
  await settle()
  return instance
}

describe('TUI — start screen', () => {
  it('needs nothing typed: shows the prompt, the kind (AUTO) and the mode', async () => {
    const { lastFrame, unmount } = await renderHome(new FakeProvider([]))
    const f = lastFrame()!
    expect(f).toContain('Ask anything')
    expect(f).toContain('AUTO')
    expect(f).toContain('BUILD')
    expect(f).toContain('test-model')
    unmount()
  })

  it('Tab toggles the draft PLAN/BUILD mode shown in the box', async () => {
    const { lastFrame, stdin, unmount } = await renderHome(new FakeProvider([]))
    stdin.write(TAB)
    await vi.waitFor(() => expect(lastFrame()).toContain('PLAN'))
    stdin.write(TAB)
    await vi.waitFor(() => expect(lastFrame()).toContain('BUILD'))
    unmount()
  })

  it('Ctrl+K opens the palette, Esc closes it, and typing still works afterwards', async () => {
    // The dead-keyboard bug: before the fix, Ctrl+K swallowed every key while
    // showing nothing — Tab, Enter and typing all appeared broken after it.
    const { lastFrame, stdin, unmount } = await renderHome(new FakeProvider([]))
    stdin.write(CTRL_K)
    await vi.waitFor(() => expect(lastFrame()).toContain('Command palette'))
    stdin.write(ESC)
    await vi.waitFor(() => expect(lastFrame()).not.toContain('Command palette'))
    stdin.write('still typing')
    await vi.waitFor(() => expect(lastFrame()).toContain('still typing'))
    unmount()
  })

  it('typed text shows in the box; a multi-character chunk is a paste, not a submit', async () => {
    const { lastFrame, stdin, unmount } = await renderHome(new FakeProvider([]))
    stdin.write('fix the failing tests')
    await vi.waitFor(() => expect(lastFrame()).toContain('fix the failing tests'))
    stdin.write(' plus more')
    await vi.waitFor(() => expect(lastFrame()).toContain('fix the failing tests plus more'))
    unmount()
  })

  it('Ctrl+G cycles AUTO → TASK → GOAL, and "/" commands work before a session exists', async () => {
    const { lastFrame, stdin, unmount } = await renderHome(new FakeProvider([]))
    await vi.waitFor(() => expect(lastFrame()).toContain('AUTO'))
    stdin.write(CTRL_G)
    await vi.waitFor(() => expect(lastFrame()).toContain('TASK'))
    stdin.write(CTRL_G)
    await vi.waitFor(() => expect(lastFrame()).toContain('GOAL'))
    stdin.write('/kind auto')
    await vi.waitFor(() => expect(lastFrame()).toContain('/kind auto'))
    stdin.write(ENTER)
    await vi.waitFor(() => expect(lastFrame()).toContain('kind → AUTO'))
    stdin.write('/sessions')
    await vi.waitFor(() => expect(lastFrame()).toContain('/sessions'))
    stdin.write(ENTER)
    await vi.waitFor(() => expect(lastFrame()).toContain('Sessions (this directory)'))
    await settle()
    stdin.write(ESC)
    await vi.waitFor(() => expect(lastFrame()).not.toContain('Sessions (this directory)'))
    unmount()
  })

  it('an empty Enter does nothing, and a very short message is a valid message (no raw validation JSON)', async () => {
    const { lastFrame, stdin, unmount } = await renderHome(new FakeProvider([{ content: 'Hi there!', toolCalls: [] }]))
    stdin.write(ENTER)
    await settle()
    expect(lastFrame()).not.toContain('too_small')
    stdin.write('hi')
    await vi.waitFor(() => expect(lastFrame()).toContain('hi'))
    stdin.write(ENTER)
    await vi.waitFor(() => expect(lastFrame()).toContain('Hi there!'), { timeout: 15_000 })
    expect(lastFrame()).not.toContain('too_small')
    unmount()
  })
})

describe('TUI — conversation vs work', () => {
  it('a greeting gets one reply, the badge says READY, and the agent does not repeat itself', async () => {
    const provider = new FakeProvider([{ content: 'Hello! What should we work on?', toolCalls: [] }])
    const { lastFrame, stdin, unmount } = await renderHome(provider)
    stdin.write('hellp')
    await settle()
    stdin.write(ENTER)
    await vi.waitFor(() => expect(lastFrame()).toContain('Hello! What should we work on?'), { timeout: 15_000 })
    await vi.waitFor(() => expect(lastFrame()).toContain('READY'))
    expect(lastFrame()).toContain('CHAT')
    // Give a (buggy) engine time to re-ask: the script is empty, so a second
    // request would show the provider's "thinking…" placeholder.
    await new Promise((r) => setTimeout(r, 300))
    expect(lastFrame()).not.toContain('thinking…')
    unmount()
  })
})

describe('TUI — session lifecycle', () => {
  it('Enter creates a session with the mode shown on screen; PLAN refuses to fake a completion', async () => {
    const { lastFrame, stdin, unmount } = await renderHome(new FakeProvider([completeTurn]))
    stdin.write(TAB) // choose PLAN before submitting
    await vi.waitFor(() => expect(lastFrame()).toContain('PLAN'))
    stdin.write('make the thing work')
    await vi.waitFor(() => expect(lastFrame()).toContain('make the thing work'))
    stdin.write(ENTER)
    // The session view replaces the start screen: the objective, the user
    // block and the chosen mode are all visible.
    await vi.waitFor(() => expect(lastFrame()).not.toContain('Ask anything'))
    expect(lastFrame()).toContain('make the thing work')
    await vi.waitFor(() => expect(lastFrame()).toContain('TASK · PLAN'))
    // The model still tries to finish: PLAN mode must refuse it VISIBLY
    // (complete is not read-only) — never pretend to a verification it
    // cannot run. The engine then keeps thinking (script exhausted).
    await vi.waitFor(() => expect(lastFrame()).toContain('Plan mode is read-only'), { timeout: 15_000 })
    expect(lastFrame()).not.toContain('SESSION COMPLETE')
    // Tab now toggles the ACTIVE session's mode, visibly in the note+header.
    stdin.write(TAB)
    await vi.waitFor(() => expect(lastFrame()).toContain('mode → BUILD'))
    expect(lastFrame()).toContain('TASK · BUILD')
    unmount()
  })

  it('Ctrl+N opens the start screen as a new tab with nothing required; Esc returns to the session and its draft', async () => {
    const { lastFrame, stdin, unmount } = await renderHome(new FakeProvider([completeTurn]))
    stdin.write('first objective aaa create')
    await vi.waitFor(() => expect(lastFrame()).toContain('first objective aaa create'))
    stdin.write(ENTER)
    // The engine runs the scripted turn: real verification, real report.
    await vi.waitFor(() => expect(lastFrame()).toContain('SESSION COMPLETE'), { timeout: 10_000 })
    expect(lastFrame()).toContain('1/1 requirements verified')

    stdin.write('draft for later')
    await vi.waitFor(() => expect(lastFrame()).toContain('draft for later'))
    stdin.write(CTRL_N)
    // The start screen, not a forced questionnaire: empty prompt, kind/mode
    // chips, recent sessions, a "+ New" tab.
    await vi.waitFor(() => expect(lastFrame()).toContain('Ask anything'))
    expect(lastFrame()).not.toContain('draft for later')
    expect(lastFrame()).toContain('+ New')
    await settle()
    stdin.write(ESC)
    await vi.waitFor(() => expect(lastFrame()).toContain('SESSION COMPLETE'))
    await vi.waitFor(() => expect(lastFrame()).toContain('draft for later'))
    unmount()
  })

  it('Ctrl+W closes the running tab, stops its engine, and returns to the previous session', async () => {
    const { lastFrame, stdin, unmount } = await renderHome(new FakeProvider([completeTurn]))
    stdin.write('first objective aaa create')
    await vi.waitFor(() => expect(lastFrame()).toContain('first objective aaa create'))
    stdin.write(ENTER)
    await vi.waitFor(() => expect(lastFrame()).toContain('SESSION COMPLETE'), { timeout: 10_000 })

    // Second session — its model never answers, so it stays running.
    stdin.write(CTRL_N)
    await vi.waitFor(() => expect(lastFrame()).toContain('Ask anything'))
    await settle()
    stdin.write('second objective bbb create')
    await vi.waitFor(() => expect(lastFrame()).toContain('second objective bbb create'))
    stdin.write(ENTER)
    // Created and attached: the new session's view takes over while it runs.
    await vi.waitFor(() => expect(lastFrame()).toContain('thinking…'), { timeout: 15_000 })

    stdin.write(CTRL_W) // closes the RUNNING tab
    // Wait for the close to finish (slow machines take longer), not for a fixed time:
    // the tab disappears and the first session is back.
    await vi.waitFor(() => expect(lastFrame()).not.toContain('second objective bbb'), { timeout: 15_000 })
    expect(lastFrame()).toContain('first objective aaa create')
    // The closed session's engine must not keep writing into the view that
    // replaced it — its text may never reappear in the restored transcript.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(lastFrame()).not.toContain('second objective bbb')
    unmount()
  })
})

describe('TUI — command palette in a session', () => {
  it('Ctrl+K opens the palette over the session and Esc restores the transcript', async () => {
    const { lastFrame, stdin, unmount } = await renderHome(new FakeProvider([completeTurn]))
    stdin.write('create the palette objective')
    await vi.waitFor(() => expect(lastFrame()).toContain('create the palette objective'))
    stdin.write(ENTER)
    await vi.waitFor(() => expect(lastFrame()).toContain('SESSION COMPLETE'), { timeout: 10_000 })

    stdin.write(CTRL_K)
    await vi.waitFor(() => expect(lastFrame()).toContain('Command palette'))
    stdin.write(ESC)
    await vi.waitFor(() => expect(lastFrame()).not.toContain('Command palette'))
    // The transcript is back, intact.
    expect(lastFrame()).toContain('SESSION COMPLETE')
    unmount()
  })
})

describe('TUI — providers and models', () => {
  it('/providers opens the manager on the start screen; Esc closes it and typing still works', async () => {
    const { lastFrame, stdin, unmount } = await renderHome(new FakeProvider([]))
    stdin.write('/providers')
    await vi.waitFor(() => expect(lastFrame()).toContain('/providers'))
    stdin.write(ENTER)
    await vi.waitFor(() => expect(lastFrame()).toContain('+ Custom provider'))
    expect(lastFrame()).toContain('+ Anthropic')
    await settle() // the overlay's own key subscription attaches after its first frame
    stdin.write(ESC)
    await vi.waitFor(() => expect(lastFrame()).not.toContain('+ Custom provider'))
    stdin.write('typing works again')
    await vi.waitFor(() => expect(lastFrame()).toContain('typing works again'))
    unmount()
  })

  it('/models lists the current provider models; /provider rejects unknown names', async () => {
    const { lastFrame, stdin, unmount } = await renderHome(new FakeProvider([]))
    stdin.write('/models')
    await settle()
    stdin.write(ENTER)
    await vi.waitFor(() => expect(lastFrame()).toContain('Models'))
    expect(lastFrame()).toContain('test-model')
    await settle()
    stdin.write(ESC)
    await vi.waitFor(() => expect(lastFrame()).not.toContain('Models —'))
    stdin.write('/provider nope')
    await settle()
    stdin.write(ENTER)
    await vi.waitFor(() => expect(lastFrame()).toContain('usage: /provider <name>'))
    unmount()
  })
})

describe('TUI — settings, themes, skills, help', () => {
  it('Ctrl+O opens settings; → on Theme switches the live palette; Esc closes', async () => {
    const { lastFrame, stdin, unmount } = await renderHome(new FakeProvider([]))
    stdin.write(CTRL_O)
    await vi.waitFor(() => expect(lastFrame()).toContain('Settings'))
    expect(lastFrame()).toContain('Theme')
    expect(lastFrame()).toContain('VARA (ember)')
    await settle()
    stdin.write(RIGHT)
    await vi.waitFor(() => expect(lastFrame()).toContain('Tokyo Night'))
    expect(theme.name).toBe('tokyo-night')
    await settle()
    stdin.write(ESC)
    await vi.waitFor(() => expect(lastFrame()).not.toContain('Settings'))
    unmount()
  })

  it('/theme <name> applies a theme; an unknown name lists the choices', async () => {
    const { lastFrame, stdin, unmount } = await renderHome(new FakeProvider([]))
    stdin.write('/theme nord')
    await settle()
    stdin.write(ENTER)
    await vi.waitFor(() => expect(lastFrame()).toContain('theme → Nord'))
    expect(theme.name).toBe('nord')
    stdin.write('/theme nope')
    await settle()
    stdin.write(ENTER)
    await vi.waitFor(() => expect(lastFrame()).toContain('usage: /theme <name>'))
    unmount()
  })

  it('/skills lists the built-in skills', async () => {
    const { lastFrame, stdin, unmount } = await renderHome(new FakeProvider([]))
    stdin.write('/skills')
    await settle()
    stdin.write(ENTER)
    await vi.waitFor(() => expect(lastFrame()).toContain('code-review'))
    expect(lastFrame()).toContain('debug')
    unmount()
  })

  it('/help opens a help view that any key closes', async () => {
    const { lastFrame, stdin, unmount } = await renderHome(new FakeProvider([]))
    stdin.write('/help')
    await settle()
    stdin.write(ENTER)
    await vi.waitFor(() => expect(lastFrame()).toContain('any key closes'))
    await settle()
    stdin.write('x')
    await vi.waitFor(() => expect(lastFrame()).not.toContain('any key closes'))
    unmount()
  })
})

describe('TUI — scrolling', () => {
  it('mouse reports are never typed into the prompt', async () => {
    const { lastFrame, stdin, unmount } = await renderHome(new FakeProvider([]))
    stdin.write('\x1b[<64;10;5M')
    stdin.write('\x1b[<0;10;5M')
    await settle()
    expect(lastFrame()).not.toContain('<64')
    expect(lastFrame()).not.toContain('[<0')
    unmount()
  })
})

describe('TUI — resuming a session with a long last answer', () => {
  it('shows the answer (its end) instead of an empty transcript', async () => {
    const { createSession, CreateSessionInput } = await import('../src/core/session.js')
    const session = createSession(CreateSessionInput.parse({ objective: 'hi', cwd: process.cwd(), auto: true }), testConfig)
    const long = Array.from({ length: 80 }, (_, i) => `- line number ${i + 1} of a very long answer`).join('\n')
    session.transcript.push(
      { role: 'user', content: 'hi', at: new Date().toISOString() },
      { role: 'assistant', content: long, at: new Date().toISOString() },
    )
    session.state = 'ready'
    const { lastFrame, unmount } = render(<App session={session} provider={new FakeProvider([])} config={testConfig} autoStart={false} />)
    await vi.waitFor(() => expect(lastFrame()).toContain('resumed session'))
    // Contiguous lines, none squeezed out, and the resume note stays visible.
    for (const n of [79, 78, 77, 76, 75]) expect(lastFrame()).toContain(`line number ${n} of`)
    expect(lastFrame()).toContain('line number 80')
    unmount()
  })
})
