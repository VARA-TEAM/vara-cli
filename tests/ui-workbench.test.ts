import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { COMMANDS } from '../src/tui/commands'
import { SHORTCUTS } from '../ui/src/components/Help'
import { dictionariesForTest } from '../ui/src/i18n'
import { COMMAND_PARITY, KEY_PARITY, SCREEN_PARITY } from '../ui/src/parity'
import { DEFAULT_LAYOUT, LIMITS, MIN_EDITOR, NARROW, PRESETS, applyPreset, canSplit, clampSize, fitToWindow, matchPreset, modeFor, parseLayout, resetPane, serializeLayout, setPane, showDock, showSide, sizeFromDrag, sizeFromKey, splitFromDrag, splitFromKey, togglePane } from '../ui/src/layout'
import { EMPTY_TABS, MAX_TABS, closeTab, moveTab, openTab, parseTabs, pruneTabs, splitWith, stepTab, swapSplit, unsplit } from '../ui/src/tabs'
import { EMPTY_SWARM, levels, mergeRuns, parseSwarmReport, reduceSwarm, runStatus, runTotals, summarizeSwarm, swarmFromTranscript, traceLayout, type SwarmState } from '../ui/src/swarm-model'
import type { ChatItem } from '../ui/src/transcript'
import type { HostEvent } from '../ui/src/types'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('layout math', () => {
  it('clamps sizes to the pane limits', () => {
    expect(clampSize('nav', 10)).toBe(LIMITS.nav.min)
    expect(clampSize('side', 99999)).toBe(LIMITS.side.max)
    expect(clampSize('dock', 200.4)).toBe(200)
  })

  it('drag direction follows the inline axis (LTR and RTL)', () => {
    // sidebar at the inline start: dragging toward the end grows it
    expect(sizeFromDrag('nav', 260, 40, false)).toBe(300)
    expect(sizeFromDrag('nav', 260, 40, true)).toBe(220)
    // side panel at the inline end: dragging toward the start grows it
    expect(sizeFromDrag('side', 340, -60, false)).toBe(400)
    expect(sizeFromDrag('side', 340, -60, true)).toBe(280)
    // dock: callers pass the upward movement as a positive delta
    expect(sizeFromDrag('dock', 200, 50, false)).toBe(250)
    expect(sizeFromDrag('nav', 260, 9999, false)).toBe(LIMITS.nav.max)
  })

  it('keyboard resizing mirrors in RTL, Shift takes a big step, Home/End/Enter jump', () => {
    expect(sizeFromKey('nav', 260, 'ArrowRight', false, false)).toBe(276)
    expect(sizeFromKey('nav', 260, 'ArrowRight', false, true)).toBe(244)
    expect(sizeFromKey('side', 340, 'ArrowLeft', true, false)).toBe(404)
    expect(sizeFromKey('dock', 200, 'ArrowUp', false, false)).toBe(216)
    expect(sizeFromKey('dock', 200, 'ArrowLeft', false, false)).toBeNull()
    expect(sizeFromKey('nav', 260, 'Home', false, false)).toBe(LIMITS.nav.min)
    expect(sizeFromKey('side', 400, 'End', false, false)).toBe(LIMITS.side.max)
    expect(sizeFromKey('side', 400, 'Enter', false, false)).toBe(LIMITS.side.def)
    expect(sizeFromKey('side', 400, 'a', false, false)).toBeNull()
  })

  it('the split divider stays inside its bounds and mirrors in RTL', () => {
    expect(splitFromDrag(0.5, 100, 1000, false)).toBe(0.6)
    expect(splitFromDrag(0.5, 100, 1000, true)).toBe(0.4)
    expect(splitFromDrag(0.5, 5000, 1000, false)).toBe(0.78)
    expect(splitFromDrag(0.5, 100, 0, false)).toBe(0.5)
    expect(splitFromKey(0.5, 'ArrowRight', false, false)).toBe(0.53)
    expect(splitFromKey(0.5, 'ArrowRight', false, true)).toBe(0.47)
    expect(splitFromKey(0.5, 'Enter', false, false)).toBe(0.5)
  })

  it('panes give way so the conversation keeps its minimum width', () => {
    const wide = fitToWindow(DEFAULT_LAYOUT, 1600, 900)
    expect(wide.nav).toBe(LIMITS.nav.def)
    expect(wide.side).toBe(LIMITS.side.def)
    const tight = fitToWindow({ ...DEFAULT_LAYOUT, side: { size: 600, open: true } }, 1000, 900)
    expect(tight.nav + tight.side + MIN_EDITOR).toBeLessThanOrEqual(1000)
    expect(tight.side).toBeLessThan(600)
    // a closed pane takes no room, and the stored sizes are untouched
    const closed = fitToWindow({ ...DEFAULT_LAYOUT, side: { size: 600, open: false } }, 1000, 900)
    expect(closed.side).toBe(0)
    const dock = fitToWindow({ ...DEFAULT_LAYOUT, dock: { size: 500, open: true } }, 1600, 600)
    expect(dock.dock).toBe(600 - 220)
  })

  it('modes and split availability by window width', () => {
    expect(modeFor(NARROW - 1)).toBe('narrow')
    expect(modeFor(1000)).toBe('medium')
    expect(modeFor(1500)).toBe('wide')
    expect(canSplit(1099)).toBe(false)
    expect(canSplit(1100)).toBe(true)
  })

  it('presets apply and are recognised again', () => {
    for (const p of PRESETS) expect(matchPreset(applyPreset(DEFAULT_LAYOUT, p.id))).toBe(p.id)
    const swarm = applyPreset(DEFAULT_LAYOUT, 'swarm')
    expect(swarm.sideTab).toBe('agents')
    expect(swarm.dock.open).toBe(true)
    const dragged = setPane(swarm, 'side', { size: 333 })
    expect(matchPreset(dragged)).toBeNull()
    expect(applyPreset(DEFAULT_LAYOUT, 'focus').side.open).toBe(false)
  })

  it('reset, toggle and show helpers', () => {
    const l = setPane(DEFAULT_LAYOUT, 'nav', { size: 400 })
    expect(resetPane(l, 'nav').nav.size).toBe(LIMITS.nav.def)
    expect(togglePane(DEFAULT_LAYOUT, 'dock').dock.open).toBe(true)
    const a = showSide({ ...DEFAULT_LAYOUT, side: { size: 340, open: false } }, 'agents')
    expect(a.side.open).toBe(true)
    expect(a.sideTab).toBe('agents')
    expect(showSide(a, 'agents', true).side.open).toBe(false)
    expect(showSide(a, 'cost', true).sideTab).toBe('cost')
    expect(showDock(DEFAULT_LAYOUT, 'preview').dock.open).toBe(true)
    expect(showDock(showDock(DEFAULT_LAYOUT, 'preview'), 'preview', true).dock.open).toBe(false)
  })

  it('persistence round-trips and survives garbage', () => {
    const l = applyPreset(DEFAULT_LAYOUT, 'preview')
    expect(parseLayout(serializeLayout(l))).toEqual(l)
    expect(parseLayout('{nope')).toEqual(DEFAULT_LAYOUT)
    expect(parseLayout(null)).toEqual(DEFAULT_LAYOUT)
    expect(parseLayout('7')).toEqual(DEFAULT_LAYOUT)
    const bad = parseLayout(JSON.stringify({ nav: { size: -50, open: 'yes' }, side: { size: 'wide' }, split: 9, sideTab: 'hack', dockTab: 5 }))
    expect(bad.nav.size).toBe(LIMITS.nav.min)
    expect(bad.nav.open).toBe(true)
    expect(bad.side.size).toBe(LIMITS.side.def)
    expect(bad.split).toBe(0.78)
    expect(bad.sideTab).toBe('proof')
    expect(bad.dockTab).toBe('output')
  })
})

describe('session tabs', () => {
  const three = (): ReturnType<typeof openTab> => ['a', 'b', 'c'].reduce(openTab, EMPTY_TABS)

  it('opening adds a tab once and activates it', () => {
    const s = openTab(three(), 'a')
    expect(s.open).toEqual(['a', 'b', 'c'])
    expect(s.active).toBe('a')
  })

  it('closing the active tab moves to the neighbour', () => {
    const s = closeTab(three(), 'c')
    expect(s.open).toEqual(['a', 'b'])
    expect(s.active).toBe('b')
    expect(closeTab(s, 'zzz')).toBe(s)
    const last = closeTab(closeTab(s, 'a'), 'b')
    expect(last).toEqual(EMPTY_TABS)
  })

  it('reorders by drag and drop', () => {
    expect(moveTab(three(), 'c', 'a').open).toEqual(['c', 'a', 'b'])
    expect(moveTab(three(), 'a', 'c').open).toEqual(['b', 'c', 'a'])
    expect(moveTab(three(), 'a', 'a').open).toEqual(['a', 'b', 'c'])
    expect(moveTab(three(), 'x', 'a').open).toEqual(['a', 'b', 'c'])
  })

  it('split view keeps two different open sessions', () => {
    let s = splitWith(three(), 'a') // active is c
    expect(s.active).toBe('c')
    expect(s.split).toBe('a')
    expect(splitWith(s, 'c').split).toBe('a')
    s = swapSplit(s)
    expect(s.active).toBe('a')
    expect(s.split).toBe('c')
    s = openTab(s, 'c') // opening the split session swaps rather than showing it twice
    expect(s.active).toBe('c')
    expect(s.split).toBe('a')
    expect(unsplit(s).split).toBeNull()
    const closed = closeTab(s, 'a')
    expect(closed.split).toBeNull()
    expect(closed.active).toBe('c')
    const closedMain = closeTab(s, 'c')
    expect(closedMain.active).toBe('a')
    expect(closedMain.split).toBeNull()
  })

  it('steps between tabs with wrap-around', () => {
    const s = three()
    expect(stepTab(s, 1)).toBe('a')
    expect(stepTab({ ...s, active: 'a' }, -1)).toBe('c')
    expect(stepTab(EMPTY_TABS, 1)).toBeNull()
  })

  it('never keeps more than the limit and prunes vanished sessions', () => {
    const many = Array.from({ length: MAX_TABS + 3 }, (_, i) => `s${i}`).reduce(openTab, EMPTY_TABS)
    expect(many.open.length).toBe(MAX_TABS)
    expect(many.active).toBe(`s${MAX_TABS + 2}`)
    const p = pruneTabs(three(), new Set(['a', 'c']))
    expect(p.open).toEqual(['a', 'c'])
    expect(p.active).toBe('c')
  })

  it('parses stored tabs defensively', () => {
    expect(parseTabs('{"open":["a","b"],"active":"b","split":"a"}')).toEqual({ open: ['a', 'b'], active: 'b', split: 'a' })
    expect(parseTabs('{"open":["a","<x>",3],"active":"zz","split":"a"}')).toEqual({ open: ['a'], active: null, split: 'a' })
    expect(parseTabs('garbage')).toEqual(EMPTY_TABS)
  })
})

describe('swarm model', () => {
  const plan = JSON.stringify({
    tasks: [
      { id: 'scan', title: 'Scan the API', role: 'researcher', prompt: 'x' },
      { id: 'impl', title: 'Implement', role: 'implementer', kind: 'work', dependsOn: ['scan'], prompt: 'y' },
      { title: 'Review', role: 'reviewer', dependsOn: ['impl'], prompt: 'z' },
    ],
  })
  const merged =
    '## Swarm result: 2 done, 1 failed, 0 skipped · 14 model calls · cost $0.0420\n\n### scan · Scan the API [researcher] — DONE\nFound three routes.\n\n### impl · Implement [implementer] — DONE\nEdited a.ts.\n\n### t3 · Review [reviewer] — FAILED\nFAILED (budget)\nnothing\n\nSub-agents that edit files have finished: check their work (git diff, the tests) before you claim anything.'
  const ev = (type: string, rest: Record<string, unknown>): HostEvent => ({ type, ...rest })

  it('parses the merged report, including unknown cost and the closing note', () => {
    const r = parseSwarmReport(merged)!
    expect(r).toMatchObject({ done: 2, failed: 1, skipped: 0, modelCalls: 14, costUsd: 0.042 })
    expect(r.sections.map((s) => [s.id, s.status, s.role])).toEqual([
      ['scan', 'done', 'researcher'],
      ['impl', 'done', 'implementer'],
      ['t3', 'failed', 'reviewer'],
    ])
    expect(r.sections[2]!.report).toBe('FAILED (budget)\nnothing')
    expect(parseSwarmReport('## Swarm result: 1 done, 0 failed, 0 skipped · 3 model calls · cost unknown')).toMatchObject({ costUsd: null })
    expect(parseSwarmReport('## Swarm result: 1 done, 0 failed, 0 skipped · 3 model calls · cost unknown (at least $0.0100)')).toMatchObject({ costUsd: null, costAtLeast: 0.01 })
    expect(parseSwarmReport('plain text')).toBeNull()
  })

  it('shows the plan as soon as the delegate call starts, with default ids like the engine', () => {
    const s = reduceSwarm(EMPTY_SWARM, ev('tool_start', { name: 'delegate', id: 'c1', args: plan }), 1000)
    expect(s.runs).toHaveLength(1)
    expect(s.runs[0]!.agents.map((a) => a.id)).toEqual(['scan', 'impl', 't3'])
    expect(runStatus(s.runs[0]!)).toBe('running')
    expect(summarizeSwarm(s.runs)).toMatchObject({ running: 0, total: 3, live: true })
  })

  it('follows a whole run through live events', () => {
    let s: SwarmState = reduceSwarm(EMPTY_SWARM, ev('tool_start', { name: 'delegate', id: 'c1', args: plan }), 1000)
    s = reduceSwarm(s, ev('subagent', { id: 'scan', title: 'Scan the API', status: 'running', role: 'researcher' }), 1100)
    s = reduceSwarm(s, ev('subagent', { id: 'scan', title: 'Scan the API', status: 'running', detail: 'grep' }), 1500)
    s = reduceSwarm(s, ev('subagent', { id: 'scan', title: 'Scan the API', status: 'running', detail: 'grep' }), 1600)
    s = reduceSwarm(s, ev('subagent', { id: 'scan', title: 'Scan the API', status: 'running', detail: 'read_file' }), 2000)
    const scan = s.runs[0]!.agents[0]!
    expect(scan).toMatchObject({ status: 'running', steps: 2, detail: 'read_file', startedAt: 1100 })
    expect(summarizeSwarm(s.runs).running).toBe(1)
    s = reduceSwarm(s, ev('subagent', { id: 'scan', title: 'Scan the API', status: 'done' }), 3000)
    expect(s.runs[0]!.agents[0]).toMatchObject({ status: 'done', endedAt: 3000 })
    expect(s.runs[0]!.agents[0]!.detail).toBeUndefined()
    s = reduceSwarm(s, ev('subagent', { id: 'impl', title: 'Implement', status: 'skipped', detail: 'a task it depends on did not finish' }), 3100)
    expect(s.runs[0]!.agents[1]).toMatchObject({ status: 'skipped', detail: 'a task it depends on did not finish' })
    s = reduceSwarm(s, ev('tool_end', { name: 'delegate', id: 'c1', ok: true, output: merged }), 4000)
    const run = s.runs[0]!
    expect(run.live).toBe(false)
    expect(run).toMatchObject({ modelCalls: 14, costUsd: 0.042, endedAt: 4000 })
    expect(run.agents.find((a) => a.id === 'scan')!.report).toBe('Found three routes.')
    expect(run.agents.find((a) => a.id === 'impl')!.status).toBe('done') // the saved report wins
    expect(runStatus(run)).toBe('failed')
  })

  it('a rejected plan is reported as rejected, not as a swarm that ran', () => {
    let s = reduceSwarm(EMPTY_SWARM, ev('tool_start', { name: 'delegate', id: 'c2', args: plan }), 1)
    s = reduceSwarm(s, ev('tool_end', { name: 'delegate', id: 'c2', ok: false, output: 'Swarm plan rejected: The dependencies form a cycle.' }), 2)
    expect(runStatus(s.runs[0]!)).toBe('rejected')
    expect(s.runs[0]!.rejected).toBe('The dependencies form a cycle.')
  })

  it('stopping the session closes an open swarm honestly', () => {
    let s = reduceSwarm(EMPTY_SWARM, ev('tool_start', { name: 'delegate', id: 'c3', args: plan }), 1)
    s = reduceSwarm(s, ev('subagent', { id: 'scan', title: 'Scan', status: 'running' }), 2)
    s = reduceSwarm(s, ev('state', { state: 'paused' }), 9)
    const a = s.runs[0]!.agents
    expect(a[0]).toMatchObject({ status: 'failed', detail: 'interrupted' })
    expect(a[1]).toMatchObject({ status: 'skipped' })
    expect(s.runs[0]!.live).toBe(false)
    expect(reduceSwarm(EMPTY_SWARM, ev('state', { state: 'idle' }), 1)).toBe(EMPTY_SWARM)
  })

  it('rebuilds past runs from the saved transcript, and merges live timing onto them', () => {
    const items: ChatItem[] = [
      { kind: 'user', text: 'go', at: 't' },
      { kind: 'tool', id: 'c1', name: 'delegate', args: plan, output: merged, ok: true, at: 't' },
      { kind: 'tool', id: 'c9', name: 'delegate', args: plan, at: 't' },
      { kind: 'tool', id: 'x', name: 'shell', args: '{}', at: 't' },
    ]
    const hist = swarmFromTranscript(items)
    expect(hist.map((r) => r.key)).toEqual(['c1', 'c9'])
    expect(hist[0]!.agents.map((a) => a.status)).toEqual(['done', 'done', 'failed'])
    expect(runStatus(hist[1]!)).toBe('planned')
    let live = reduceSwarm(EMPTY_SWARM, ev('tool_start', { name: 'delegate', id: 'c9', args: plan }), 100)
    live = reduceSwarm(live, ev('subagent', { id: 'scan', title: 'Scan', status: 'running', detail: 'grep' }), 200)
    const both = mergeRuns(hist, live.runs)
    expect(both).toHaveLength(2)
    expect(both[1]!.agents[0]).toMatchObject({ status: 'running', detail: 'grep', startedAt: 200 })
    expect(both[1]!.live).toBe(true)
    expect(both[0]!.live).toBe(false)
    // a live run the transcript does not know yet is kept
    const extra = reduceSwarm(EMPTY_SWARM, ev('tool_start', { name: 'delegate', id: 'new', args: plan }), 5)
    expect(mergeRuns(hist, extra.runs).map((r) => r.key)).toEqual(['c1', 'c9', 'new'])
  })

  it('layers the dependency graph and never loops on a cycle', () => {
    const run = swarmFromTranscript([{ kind: 'tool', id: 'c', name: 'delegate', args: plan, at: 't' }])[0]!
    expect(levels(run.agents)).toEqual([['scan'], ['impl'], ['t3']])
    const cyc = [
      { ...run.agents[0]!, id: 'a', dependsOn: ['b'] },
      { ...run.agents[0]!, id: 'b', dependsOn: ['a'] },
    ]
    expect(levels(cyc).flat().sort()).toEqual(['a', 'b'])
  })

  it('lays out the trace from timestamps, with a schematic fallback', () => {
    let s = reduceSwarm(EMPTY_SWARM, ev('tool_start', { name: 'delegate', id: 'c1', args: plan }), 0)
    s = reduceSwarm(s, ev('subagent', { id: 'scan', title: 'Scan', status: 'running' }), 0)
    s = reduceSwarm(s, ev('subagent', { id: 'scan', title: 'Scan', status: 'done' }), 4000)
    s = reduceSwarm(s, ev('subagent', { id: 'impl', title: 'Impl', status: 'running' }), 4000)
    const lanes = traceLayout(s.runs[0]!, 8000)
    expect(lanes[0]).toMatchObject({ id: 'scan', x0: 0, timed: true })
    expect(lanes[0]!.x1).toBeCloseTo(0.5)
    expect(lanes[1]).toMatchObject({ id: 'impl', timed: true, open: true })
    expect(lanes[1]!.x0).toBeCloseTo(0.5)
    expect(lanes[1]!.x1).toBeCloseTo(1)
    expect(lanes[2]!.timed).toBe(false)
    expect(lanes[2]!.x0).toBeGreaterThan(0)
    const schematic = traceLayout(swarmFromTranscript([{ kind: 'tool', id: 'c', name: 'delegate', args: plan, at: 't' }])[0]!, 0)
    expect(schematic.every((l) => !l.timed)).toBe(true)
    expect(schematic[0]!.x0).toBeLessThan(schematic[1]!.x0)
    for (const l of [...lanes, ...schematic]) {
      expect(l.x0).toBeGreaterThanOrEqual(0)
      expect(l.x1).toBeLessThanOrEqual(1)
      expect(l.x1).toBeGreaterThan(l.x0)
    }
  })
})

describe('swarm model — what the host reports per agent', () => {
  const plan = JSON.stringify({ tasks: [{ id: 'a', title: 'A', prompt: 'x' }, { id: 'b', title: 'B', prompt: 'y' }, { id: 'c', title: 'C', prompt: 'z' }] })
  const ev = (type: string, rest: Record<string, unknown>): HostEvent => ({ type, ...rest })

  it('uses the host step count, calls, cost, report and cancellation', () => {
    let s = reduceSwarm(EMPTY_SWARM, ev('tool_start', { name: 'delegate', id: 'd1', args: plan }), 0)
    s = reduceSwarm(s, ev('subagent', { id: 'a', title: 'A', status: 'running', detail: 'grep', steps: 1, swarm: 1, kind: 'explore' }), 100)
    s = reduceSwarm(s, ev('subagent', { id: 'a', title: 'A', status: 'running', detail: 'grep', steps: 2, swarm: 1 }), 200)
    s = reduceSwarm(s, ev('subagent', { id: 'a', title: 'A', status: 'running', detail: 'grep', steps: 2, swarm: 1 }), 250)
    expect(s.runs[0]!.agents[0]).toMatchObject({ steps: 2, kind: 'explore', startedAt: 100 })
    expect(s.runs[0]!.agents[0]!.stepAt).toEqual([100, 200])
    s = reduceSwarm(s, ev('subagent', { id: 'a', title: 'A', status: 'done', calls: 3, costUsd: 0.0123, report: 'Found it.' }), 300)
    s = reduceSwarm(s, ev('subagent', { id: 'b', title: 'B', status: 'running', detail: 'shell', steps: 1 }), 310)
    s = reduceSwarm(s, ev('subagent', { id: 'b', title: 'B', status: 'failed', calls: 2, costUsd: null, report: 'CANCELLED by the user.', cancelled: true }), 400)
    const [a, b, c] = s.runs[0]!.agents
    expect(a).toMatchObject({ status: 'done', calls: 3, costUsd: 0.0123, report: 'Found it.' })
    expect(b).toMatchObject({ status: 'failed', cancelled: true, costUsd: null })
    expect(c!.status).toBe('waiting')
    // the running total never turns an unknown cost into a number
    const t = runTotals(s.runs[0]!)
    expect(t).toMatchObject({ calls: 5, costUsd: null, any: true })
    expect(t.atLeast).toBeCloseTo(0.0123)
  })

  it('a cost known for every finished agent adds up; nothing reported means nothing shown', () => {
    let s = reduceSwarm(EMPTY_SWARM, ev('tool_start', { name: 'delegate', id: 'd2', args: plan }), 0)
    expect(runTotals(s.runs[0]!)).toMatchObject({ any: false, calls: 0, costUsd: null })
    s = reduceSwarm(s, ev('subagent', { id: 'a', title: 'A', status: 'done', calls: 2, costUsd: 0.01 }), 10)
    s = reduceSwarm(s, ev('subagent', { id: 'b', title: 'B', status: 'done', calls: 4, costUsd: 0.02 }), 20)
    expect(runTotals(s.runs[0]!)).toMatchObject({ calls: 6, any: true })
    expect(runTotals(s.runs[0]!).costUsd).toBeCloseTo(0.03)
  })

  it('the swarm_report event fills the merged report and totals, and marks cancelled agents', () => {
    let s = reduceSwarm(EMPTY_SWARM, ev('tool_start', { name: 'delegate', id: 'd3', args: plan }), 0)
    const merged = '## Swarm result: 1 done, 1 failed, 1 skipped · 9 model calls · cost $0.0300\n\n### a · A — DONE\nok\n\n### b · B — FAILED\nCANCELLED by the user.\n\n### c · C — SKIPPED\ncancelled by the user'
    s = reduceSwarm(s, ev('swarm_report', { swarm: 1, merged, modelCalls: 9, costUsd: 0.03, done: 1, failed: 1, skipped: 1 }), 50)
    const run = s.runs[0]!
    expect(run).toMatchObject({ modelCalls: 9, costUsd: 0.03 })
    expect(run.agents.map((x) => x.status)).toEqual(['done', 'failed', 'skipped'])
    expect(run.agents[1]!.cancelled).toBe(true)
    expect(runTotals(run)).toMatchObject({ calls: 9, costUsd: 0.03 })
  })
})

describe('terminal ↔ browser parity', () => {
  const read = (p: string): string => readFileSync(join(root, p), 'utf8')
  const walk = (dir: string): string[] => readdirSync(join(root, dir)).flatMap((n) => (statSync(join(root, dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]))
  const uiSource = walk('ui/src').filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('parity.ts')).map(read).join('\n')

  it('every terminal command has a row, and every row is a real terminal command (or planned)', () => {
    const rows = new Map(COMMAND_PARITY.map((r) => [r.tui, r]))
    expect(rows.size).toBe(COMMAND_PARITY.length)
    for (const c of COMMANDS) expect(rows.has(c.name), `no parity row for ${c.name}`).toBe(true)
    for (const r of COMMAND_PARITY) if (r.status !== 'planned') expect(COMMANDS.some((c) => c.name === r.tui), `${r.tui} is not a terminal command`).toBe(true)
  })

  it('a row says "same" only when the browser registers that command', () => {
    for (const r of COMMAND_PARITY) {
      const registered = r.slash ? uiSource.includes(`slash: '${r.slash}'`) : false
      if (r.status === 'same' || r.status === 'adapted') {
        expect(r.slash, `${r.tui} needs a slash`).toBeTruthy()
        expect(registered, `the browser does not register /${r.slash}`).toBe(true)
        expect(r.slash).toBe(r.tui.slice(1))
      } else if (r.status === 'planned') {
        // The moment the browser grows it, the row must be flipped (and the docs regenerated).
        expect(uiSource.includes(`slash: '${r.tui.slice(1)}'`), `${r.tui} now exists in the browser: mark it same`).toBe(false)
      }
    }
  })

  it('every terminal key action has a row', () => {
    const src = read('src/tui/keymap.ts')
    const block = src.slice(src.indexOf('export type KeyAction'), src.indexOf('/** SGR mouse'))
    const actions = [...block.matchAll(/\{ type: '([a-z-]+)'/g)].map((m) => m[1]!)
    expect(actions.length).toBeGreaterThan(15)
    const rows = new Set(KEY_PARITY.map((r) => r.action))
    for (const a of actions) expect(rows.has(a), `no parity row for key action ${a}`).toBe(true)
  })

  it('the documented shortcuts are the ones the browser handles', () => {
    for (const s of SHORTCUTS) expect(dictionariesForTest.en[s.what], s.what).toBeTruthy()
    const keyHandlers = readFileSync(join(root, 'ui/src/components/Workbench.tsx'), 'utf8') + readFileSync(join(root, 'ui/src/components/App.tsx'), 'utf8') + readFileSync(join(root, 'ui/src/components/SessionPage.tsx'), 'utf8')
    for (const needle of ["key.toLowerCase() === 'k'", "key.toLowerCase() === 'o'", "key.toLowerCase() === 'b'", "e.key === '.'", "e.key === '`'", "key.toLowerCase() === 'a'", "e.key === '\\\\'", "ArrowLeft", "key.toLowerCase() === 'w'", "key.toLowerCase() === 'm'", "key.toLowerCase() === 'g'"]) expect(keyHandlers.includes(needle), needle).toBe(true)
  })

  it('both architecture documents carry the same tables as the data', () => {
    for (const [file, lang] of [['docs/ARCHITECTURE.md', 'en'], ['docs/ar/ARCHITECTURE.md', 'ar']] as const) {
      const doc = read(file)
      const a = doc.indexOf('<!-- parity:begin -->')
      const b = doc.indexOf('<!-- parity:end -->')
      expect(a, file).toBeGreaterThan(0)
      expect(b, file).toBeGreaterThan(a)
      const table = doc.slice(a, b)
      const label = lang === 'en' ? { same: 'same', adapted: 'adapted', na: 'not applicable', planned: 'planned' } : { same: 'نفسه', adapted: 'مكيَّف', na: 'لا ينطبق', planned: 'مخطَّط' }
      for (const r of COMMAND_PARITY) {
        const line = table.split('\n').find((l) => l.startsWith(`| \`${r.tui}\` |`))
        expect(line, `${file}: ${r.tui}`).toBeTruthy()
        expect(line!.trimEnd().endsWith(`| ${label[r.status]} |`), `${file}: ${r.tui} status`).toBe(true)
        if (lang === 'en') expect(line!.includes(r.web.replace(/\|/g, '\\|')), `${file}: ${r.tui} text`).toBe(true)
      }
      for (const r of KEY_PARITY) expect(table.includes(`| \`${r.action}\` |`), `${file}: key ${r.action}`).toBe(true)
      for (const r of SCREEN_PARITY) expect(table.includes(`| ${r.tui} |`), `${file}: ${r.tui}`).toBe(true)
    }
  })
})

describe('swarm model — saved and live meet', () => {
  it('per-agent figures from the live events survive the merge with the saved conversation', () => {
    const plan = JSON.stringify({ tasks: [{ id: 'a', title: 'A', prompt: 'x' }] })
    const saved = swarmFromTranscript([{ kind: 'tool', id: 'c1', name: 'delegate', args: plan, output: '## Swarm result: 1 done, 0 failed, 0 skipped · 2 model calls · cost unknown\n\n### a · A — DONE\nok', ok: true, at: 't' }])
    let live = reduceSwarm(EMPTY_SWARM, { type: 'tool_start', name: 'delegate', id: 'c1', args: plan }, 0)
    live = reduceSwarm(live, { type: 'subagent', id: 'a', title: 'A', status: 'done', calls: 2, costUsd: null, cancelled: false }, 5)
    const [run] = mergeRuns(saved, live.runs)
    expect(run!.agents[0]).toMatchObject({ status: 'done', report: 'ok', calls: 2, costUsd: null })
  })
})
