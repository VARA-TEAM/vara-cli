import React from 'react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render, cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantTurn, Provider, ProviderEvent, ProviderRequest } from '../src/llm/provider.js'
import { DEFAULT_CONFIG, type VaraConfig } from '../src/config/config.js'
import { App } from '../src/tui/App.js'
import { applyTheme } from '../src/tui/theme.js'
import { createSession, CreateSessionInput } from '../src/core/session.js'
import { settingItems } from '../src/tui/settings.js'
import { COMMANDS } from '../src/tui/commands.js'
import { resolveKey } from '../src/tui/keymap.js'

const ENTER = '\r'
const ESC = '\x1b'
const settle = (ms = 70) => new Promise((r) => setTimeout(r, ms))

afterEach(() => {
  cleanup()
  applyTheme('vara')
})

const plan = [
  { id: 'auth', title: 'review auth', prompt: 'Review src/auth for bugs. Report file:line findings.', role: 'reviewer' },
  { id: 'billing', title: 'review billing', prompt: 'Review src/billing for bugs. Report file:line findings.', role: 'reviewer' },
  { id: 'tests', title: 'write tests', prompt: 'Write tests for the auth findings only.', role: 'tester', dependsOn: ['auth'] },
]

/** Parent delegates once, then waits for the user; children answer after a short delay. */
class Lab implements Provider {
  id = 'openai' as const
  parentTurns = 0
  async *chat(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    if (req.system.includes('You are a sub-agent')) {
      await settle(120)
      const turn: AssistantTurn = { content: 'child report: all good', toolCalls: [{ id: 'q', name: 'ask_user', arguments: JSON.stringify({ question: 'anything else?' }) }] }
      yield { type: 'text', delta: turn.content }
      yield { type: 'done', result: turn }
      return
    }
    this.parentTurns++
    if (this.parentTurns === 1) {
      yield { type: 'done', result: { content: '', toolCalls: [{ id: 'd', name: 'delegate', arguments: JSON.stringify({ tasks: plan }) }] } }
      return
    }
    yield { type: 'done', result: { content: 'Reviewed.', toolCalls: [{ id: 'z', name: 'ask_user', arguments: JSON.stringify({ question: 'what next, please?' }) }] } }
  }
}

const config: VaraConfig = { ...DEFAULT_CONFIG, provider: { ...DEFAULT_CONFIG.provider, model: 'test-model' } }

describe('TUI — sub-agents are visible', () => {
  it('shows the agents live in the conversation and the side panel, and /agents opens the full view', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vara-agents-'))
    try {
      const s = createSession(CreateSessionInput.parse({ kind: 'task', mode: 'build', objective: 'Review auth and billing', acceptance: ['reviewed'], cwd: dir, auto: false }), config)
      const inst = render(<App session={s} provider={new Lab()} config={config} autoStart />)
      await settle()

      // while they run: lines in the conversation, with roles and the dependency
      await vi.waitFor(() => expect(inst.lastFrame()).toMatch(/agent #1 · .*review auth \[reviewer\]/), { timeout: 4000 })
      expect(inst.lastFrame()).toMatch(/write tests \[tester\] ← auth/)

      // when the swarm ends: one summary line, and the panel keeps the finished swarm
      await vi.waitFor(() => expect(inst.lastFrame()).toMatch(/agents #1: 3 done/), { timeout: 6000 })
      expect(inst.lastFrame()).toContain('AGENTS #1')

      // /agents: the full view with every agent, then back with Esc
      inst.stdin.write('/agents')
      await settle()
      inst.stdin.write(ENTER)
      await vi.waitFor(() => expect(inst.lastFrame()).toContain('Agents #1'), { timeout: 3000 })
      const f = inst.lastFrame()!
      expect(f).toContain('review billing')
      expect(f).toContain('cancel')
      await settle()
      inst.stdin.write(ESC)
      await vi.waitFor(() => expect(inst.lastFrame()).not.toContain('↑/↓ pick'), { timeout: 3000 })
      inst.unmount()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it('the command, the key map and the settings know about agents', () => {
    expect(COMMANDS.some((c) => c.name === '/agents')).toBe(true)
    expect(resolveKey('x', {} as never, { view: 'session', overlay: 'agents', running: false, escArmed: false }).type).toBe('overlay-input')
    const items = settingItems([])
    for (const id of ['section-agents', 'swarmTasks', 'swarmParallel', 'swarmCalls', 'swarmCost']) expect(items.some((i) => i.id === id), id).toBe(true)
    // the limits can only be lowered
    const tasks = items.find((i) => i.id === 'swarmTasks')!
    expect(tasks.commit!(config, '9')).toMatch(/At most 4/)
    expect((tasks.commit!(config, '2') as VaraConfig).swarm.maxTasks).toBe(2)
    const parallel = items.find((i) => i.id === 'swarmParallel')!
    expect(parallel.commit!(config, '4')).toMatch(/At most 3/)
    const cost = items.find((i) => i.id === 'swarmCost')!
    expect((cost.commit!(config, '0.5') as VaraConfig).swarm.maxCostUsd).toBe(0.5)
    expect((cost.commit!({ ...config, swarm: { ...config.swarm, maxCostUsd: 3 } }, '') as VaraConfig).swarm.maxCostUsd).toBeNull()
    const toggle = items.find((i) => i.id === 'section-agents')!
    const off = toggle.cycle!(config, 1)
    expect(off.ui.sections.agents).toBe(false)
  })
})
