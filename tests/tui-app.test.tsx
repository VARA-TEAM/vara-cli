import React from 'react'
import { render, cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Provider, ProviderRequest, ProviderEvent, AssistantTurn } from '../src/llm/provider.js'
import { DEFAULT_CONFIG, type VaraConfig } from '../src/config/config.js'
import { App } from '../src/tui/App.js'

/**
 * Component-level regression tests for the TUI — the layer where the incident
 * actually happened (unit tests stayed green the whole time). Keys are fed the
 * way a terminal delivers them: a lone "\r" is Enter, a multi-character chunk
 * is a paste, "\t" is Tab, "\x0b" is Ctrl+K, "\x0e" is Ctrl+N, "\x1b" is Esc.
 */

afterEach(() => cleanup())

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

async function renderWelcome(provider: Provider) {
  const instance = render(<App session={null} provider={provider} config={testConfig} autoStart={false} />)
  await vi.waitFor(() => expect(instance.lastFrame()).toContain('Enter starts the session'))
  // The first frame renders before React's passive effects run — and ink
  // attaches its stdin 'readable' listener inside an effect. Writing keys
  // before that silently drops them, so let effects flush first.
  await new Promise((resolve) => setTimeout(resolve, 60))
  return instance
}

describe('TUI — welcome screen', () => {
  it('Tab toggles the draft PLAN/BUILD mode shown in the box', async () => {
    const { lastFrame, stdin, unmount } = await renderWelcome(new FakeProvider([]))
    await vi.waitFor(() => expect(lastFrame()).toContain('BUILD'))
    stdin.write('\t')
    await vi.waitFor(() => expect(lastFrame()).toContain('PLAN'))
    stdin.write('\t')
    await vi.waitFor(() => expect(lastFrame()).toContain('BUILD'))
    unmount()
  })

  it('Ctrl+K opens the palette, Esc closes it, and typing still works afterwards', async () => {
    // The dead-keyboard bug: before the fix, Ctrl+K swallowed every key while
    // showing nothing — Tab, Enter and typing all appeared broken after it.
    const { lastFrame, stdin, unmount } = await renderWelcome(new FakeProvider([]))
    stdin.write('\x0b') // Ctrl+K
    await vi.waitFor(() => expect(lastFrame()).toContain('Command palette'))
    stdin.write('\x1b') // Esc
    await vi.waitFor(() => expect(lastFrame()).not.toContain('Command palette'))
    stdin.write('still typing')
    await vi.waitFor(() => expect(lastFrame()).toContain('still typing'))
    unmount()
  })

  it('typed text shows in the box and Enter is not swallowed by pastes', async () => {
    const { lastFrame, stdin, unmount } = await renderWelcome(new FakeProvider([]))
    stdin.write('fix the failing tests')
    await vi.waitFor(() => expect(lastFrame()).toContain('fix the failing tests'))
    // A multi-character chunk must stay text (paste semantics), not submit.
    stdin.write(' plus more')
    await vi.waitFor(() => expect(lastFrame()).toContain('fix the failing tests plus more'))
    unmount()
  })

  it('Ctrl+G switches the draft kind, and "/" commands work before a session exists', async () => {
    const { lastFrame, stdin, unmount } = await renderWelcome(new FakeProvider([]))
    await vi.waitFor(() => expect(lastFrame()).toContain('TASK'))
    stdin.write('\x07') // Ctrl+G
    // The box itself shows the new policy — no hidden state.
    await vi.waitFor(() => expect(lastFrame()).toContain('GOAL'))
    // "/kind" reaches the dispatcher on the welcome screen too — the old
    // inline gate blocked every command except /help.
    stdin.write('/kind task')
    await vi.waitFor(() => expect(lastFrame()).toContain('/kind task'))
    stdin.write('\r')
    await vi.waitFor(() => expect(lastFrame()).toContain('kind → TASK'))
    // "/sessions" opens the real overlay pre-session; Esc closes it.
    stdin.write('/sessions')
    await vi.waitFor(() => expect(lastFrame()).toContain('/sessions'))
    stdin.write('\r')
    await vi.waitFor(() => expect(lastFrame()).toContain('Sessions (this directory)'))
    stdin.write('\x1b')
    await vi.waitFor(() => expect(lastFrame()).not.toContain('Sessions (this directory)'))
    unmount()
  })
})

describe('TUI — session lifecycle', () => {
  it('Enter creates a session with the mode shown on screen; PLAN refuses to fake a completion', async () => {
    const { lastFrame, stdin, unmount } = await renderWelcome(new FakeProvider([completeTurn]))
    stdin.write('\t') // choose PLAN before submitting
    await vi.waitFor(() => expect(lastFrame()).toContain('PLAN'))
    stdin.write('make the thing work')
    await vi.waitFor(() => expect(lastFrame()).toContain('make the thing work'))
    stdin.write('\r') // Enter
    // The session view replaces the welcome screen — the logo is gone, and
    // the objective, the user block and the chosen mode are all visible.
    await vi.waitFor(() => expect(lastFrame()).not.toContain('██╗'))
    expect(lastFrame()).toContain('make the thing work')
    expect(lastFrame()).toContain('TASK · PLAN')
    // The model still tries to finish: PLAN mode must refuse it VISIBLY
    // (complete is not read-only) — never pretend to a verification it
    // cannot run. The engine then keeps thinking (script exhausted).
    await vi.waitFor(() => expect(lastFrame()).toContain('Plan mode is read-only'), { timeout: 5_000 })
    expect(lastFrame()).not.toContain('SESSION COMPLETE')
    // Tab now toggles the ACTIVE session's mode, visibly in the note+header.
    stdin.write('\t')
    await vi.waitFor(() => expect(lastFrame()).toContain('mode → BUILD'))
    expect(lastFrame()).toContain('TASK · BUILD')
    unmount()
  })

  it('Ctrl+N opens a focused objective entry; Esc cancels and restores the draft', async () => {
    const { lastFrame, stdin, unmount } = await renderWelcome(new FakeProvider([completeTurn]))
    stdin.write('first objective aaa')
    await vi.waitFor(() => expect(lastFrame()).toContain('first objective aaa'))
    stdin.write('\r')
    // The engine runs the scripted turn: real verification, real report.
    // (A full turn — chat + node verification + saves — takes ~1.5s, well
    // past vi.waitFor's 1s default.)
    await vi.waitFor(() => expect(lastFrame()).toContain('SESSION COMPLETE'), { timeout: 10_000 })
    expect(lastFrame()).toContain('1/1 requirements verified')

    stdin.write('draft for later')
    await vi.waitFor(() => expect(lastFrame()).toContain('draft for later'))
    stdin.write('\x0e') // Ctrl+N
    // The entry is focused: it shows the mode that will be used, and the old
    // draft does not leak into the new objective.
    await vi.waitFor(() => expect(lastFrame()).toContain('objective[TASK·BUILD] ▸'))
    expect(lastFrame()).not.toContain('draft for later')
    stdin.write('\x1b') // Esc cancels
    await vi.waitFor(() => expect(lastFrame()).toContain('new session cancelled'))
    await vi.waitFor(() => expect(lastFrame()).toContain('draft for later'))
    unmount()
  })

  it('Ctrl+W closes the running tab, stops its engine, and returns to the previous session', async () => {
    const { lastFrame, stdin, unmount } = await renderWelcome(new FakeProvider([completeTurn]))
    stdin.write('first objective aaa')
    await vi.waitFor(() => expect(lastFrame()).toContain('first objective aaa'))
    stdin.write('\r')
    await vi.waitFor(() => expect(lastFrame()).toContain('SESSION COMPLETE'), { timeout: 10_000 })

    // Second session — its model never answers, so it stays running.
    stdin.write('\x0e') // Ctrl+N
    await vi.waitFor(() => expect(lastFrame()).toContain('objective[TASK·BUILD] ▸'))
    stdin.write('second objective bbb')
    await vi.waitFor(() => expect(lastFrame()).toContain('second objective bbb'))
    stdin.write('\r')
    // Created and attached: the new session's view takes over while it runs.
    await vi.waitFor(() => expect(lastFrame()).toContain('thinking…'), { timeout: 5_000 })

    stdin.write('\x17') // Ctrl+W closes the RUNNING tab
    await vi.waitFor(() => expect(lastFrame()).toContain('first objective aaa'))
    // The closed session's engine must not keep writing into the view that
    // replaced it — its text may never appear in the restored transcript.
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(lastFrame()).not.toContain('second objective bbb')
    unmount()
  })
})

describe('TUI — command palette in a session', () => {
  it('Ctrl+K opens the palette over the session and Esc restores the transcript', async () => {
    const { lastFrame, stdin, unmount } = await renderWelcome(new FakeProvider([completeTurn]))
    stdin.write('palette objective')
    await vi.waitFor(() => expect(lastFrame()).toContain('palette objective'))
    stdin.write('\r')
    await vi.waitFor(() => expect(lastFrame()).toContain('SESSION COMPLETE'), { timeout: 10_000 })

    stdin.write('\x0b') // Ctrl+K
    await vi.waitFor(() => expect(lastFrame()).toContain('Command palette'))
    stdin.write('\x1b') // Esc
    await vi.waitFor(() => expect(lastFrame()).not.toContain('Command palette'))
    // The transcript is back, intact.
    expect(lastFrame()).toContain('SESSION COMPLETE')
    unmount()
  })
})
