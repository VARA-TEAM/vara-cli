import React, { useMemo } from 'react'
import { Box, Text, useInput } from 'ink'
import type { VaraConfig, SidebarSections } from '../config/config.js'
import { THEMES } from './theme.js'
import { parseTokens, useSync, windowStart } from './providers.js'
import { glyph, theme } from './theme.js'

export interface SkillRow {
  name: string
  description: string
  source: string
  enabled: boolean
}

type Kind = 'toggle' | 'choice' | 'number' | 'text' | 'action'

export interface SettingItem {
  id: string
  group: string
  label: string
  help: string
  kind: Kind
  /** Current value as displayed. */
  show(c: VaraConfig): string
  options?: string[]
  /** toggle/choice: next value. */
  cycle?(c: VaraConfig, dir: 1 | -1): VaraConfig
  /** number/text: parse typed text → new config, or an error string. */
  commit?(c: VaraConfig, text: string): VaraConfig | string
  /** Prefill for number/text editing. */
  edit?(c: VaraConfig): string
}

const onOff = (v: boolean) => (v ? 'on' : 'off')
const minutes = (ms: number) => String(Math.round(ms / 60_000))

function toggle(id: string, group: string, label: string, help: string, get: (c: VaraConfig) => boolean, set: (c: VaraConfig, v: boolean) => VaraConfig): SettingItem {
  return { id, group, label, help, kind: 'toggle', show: (c) => onOff(get(c)), cycle: (c) => set(c, !get(c)) }
}

function posInt(text: string, min = 1): number | undefined {
  const n = Number(text.trim())
  return Number.isInteger(n) && n >= min ? n : undefined
}

const SECTION_LABELS: Array<[keyof SidebarSections, string, string]> = [
  ['session', 'Session info', 'intent, mode, provider and model'],
  ['context', 'Context window', 'tokens used vs. the model window'],
  ['requirements', 'Requirements', 'what must be proven, and what already is'],
  ['files', 'Changed files', 'files the agent created, edited or deleted'],
  ['cost', 'Cost', 'spend and token counts'],
  ['budget', 'Budget & proof', 'turns, model calls, evidence, tool calls'],
  ['skills', 'Skills', 'skills available to the agent'],
]

/** Every setting, in display order. Pure data: the screen below just renders it. */
export function settingItems(skills: SkillRow[]): SettingItem[] {
  const items: SettingItem[] = [
    {
      id: 'theme',
      group: 'Appearance',
      label: 'Theme',
      help: 'Applies instantly. ←/→ to preview.',
      kind: 'choice',
      options: THEMES.map((t) => t.name),
      show: (c) => THEMES.find((t) => t.name === c.ui.theme)?.label ?? c.ui.theme,
      cycle: (c, dir) => {
        const i = Math.max(0, THEMES.findIndex((t) => t.name === c.ui.theme))
        return { ...c, ui: { ...c.ui, theme: THEMES[(i + dir + THEMES.length) % THEMES.length]!.name } }
      },
    },
    toggle('fullscreen', 'Appearance', 'Full-screen mode', 'Own screen buffer: a stable frame, no ghost frames in the scrollback. Restart to apply.', (c) => c.ui.fullscreen, (c, v) => ({ ...c, ui: { ...c.ui, fullscreen: v } })),
    toggle('mouse', 'Appearance', 'Mouse wheel scrolling', 'Scroll the transcript with the wheel (hold Shift to select text). Restart to apply.', (c) => c.ui.mouse, (c, v) => ({ ...c, ui: { ...c.ui, mouse: v } })),
    toggle('showThinking', 'Appearance', 'Show model reasoning', 'A dim live line while the model thinks (when the provider streams it).', (c) => c.ui.showThinking, (c, v) => ({ ...c, ui: { ...c.ui, showThinking: v } })),
    toggle('toolDetails', 'Appearance', 'Tool call details', 'Show arguments / first output line after each tool name.', (c) => c.ui.toolDetails, (c, v) => ({ ...c, ui: { ...c.ui, toolDetails: v } })),
    toggle('sidebar', 'Side panel', 'Show side panel', 'Ctrl+B toggles it for the current run. Needs a wide terminal (100+ columns).', (c) => c.ui.sidebar, (c, v) => ({ ...c, ui: { ...c.ui, sidebar: v } })),
  ]
  for (const [key, label, help] of SECTION_LABELS) {
    items.push(toggle(`section-${key}`, 'Side panel', `  ${label}`, help, (c) => c.ui.sections[key], (c, v) => ({ ...c, ui: { ...c.ui, sections: { ...c.ui.sections, [key]: v } } })))
  }
  items.push(
    toggle('autoIntent', 'Agent', 'Understand each message', 'Chat → answer, question → read-only, task/goal → full work. Off: every message runs as the chosen kind.', (c) => c.agent.autoIntent, (c, v) => ({ ...c, agent: { ...c.agent, autoIntent: v } })),
    {
      id: 'defaultMode',
      group: 'Agent',
      label: 'Default mode',
      help: 'PLAN reads only; BUILD can change files and run commands.',
      kind: 'choice',
      options: ['plan', 'build'],
      show: (c) => c.agent.defaultMode.toUpperCase(),
      cycle: (c) => ({ ...c, agent: { ...c.agent, defaultMode: c.agent.defaultMode === 'build' ? 'plan' : 'build' } }),
    },
    {
      id: 'verify',
      group: 'Agent',
      label: 'Verify command',
      help: 'Run before a task may complete, e.g. "npm test". Empty = none.',
      kind: 'text',
      show: (c) => c.defaultVerifyCommand || '(none)',
      edit: (c) => c.defaultVerifyCommand,
      commit: (c, t) => ({ ...c, defaultVerifyCommand: t.trim() }),
    },
    {
      id: 'cheapModel',
      group: 'Agent',
      label: 'Cheap model',
      help: 'Used for chat, questions and sub-agents (same provider). Big saving: empty = always the session model.',
      kind: 'text',
      show: (c) => c.agent.cheapModel || '(none — use the session model)',
      edit: (c) => c.agent.cheapModel,
      commit: (c, t) => ({ ...c, agent: { ...c.agent, cheapModel: t.trim() } }),
    },
    toggle('updates', 'Agent', 'Check for updates', 'Once a day VARA asks GitHub if a newer release exists (nothing else is sent) and tells you here. Update with: vara update.', (c) => c.updates.check, (c, v) => ({ ...c, updates: { ...c.updates, check: v } })),
    toggle('publish', 'Agent', 'Allow publishing', 'Let the agent git push / write to GitHub. Keep off unless you trust the task.', (c) => c.allowPublish, (c, v) => ({ ...c, allowPublish: v })),
    {
      id: 'taskTurns',
      group: 'Budgets',
      label: 'Task: max turns',
      help: 'A task pauses after this many turns.',
      kind: 'number',
      show: (c) => String(c.budgets.task.maxTurns),
      edit: (c) => String(c.budgets.task.maxTurns),
      commit: (c, t) => {
        const n = posInt(t)
        return n === undefined ? 'Enter a whole number ≥ 1.' : { ...c, budgets: { ...c.budgets, task: { ...c.budgets.task, maxTurns: n } } }
      },
    },
    {
      id: 'taskMinutes',
      group: 'Budgets',
      label: 'Task: max minutes',
      help: 'Wall-clock limit for one task.',
      kind: 'number',
      show: (c) => `${minutes(c.budgets.task.maxDurationMs)} min`,
      edit: (c) => minutes(c.budgets.task.maxDurationMs),
      commit: (c, t) => {
        const n = posInt(t)
        return n === undefined ? 'Enter a whole number of minutes ≥ 1.' : { ...c, budgets: { ...c.budgets, task: { ...c.budgets.task, maxDurationMs: n * 60_000 } } }
      },
    },
    {
      id: 'taskCalls',
      group: 'Budgets',
      label: 'Task: max model calls',
      help: 'Hard cap on requests to the model.',
      kind: 'number',
      show: (c) => String(c.budgets.task.maxModelCalls),
      edit: (c) => String(c.budgets.task.maxModelCalls),
      commit: (c, t) => {
        const n = posInt(t)
        return n === undefined ? 'Enter a whole number ≥ 1.' : { ...c, budgets: { ...c.budgets, task: { ...c.budgets.task, maxModelCalls: n } } }
      },
    },
    {
      id: 'goalTurns',
      group: 'Budgets',
      label: 'Goal: max turns',
      help: 'A goal pauses after this many cycles.',
      kind: 'number',
      show: (c) => String(c.budgets.goal.maxTurns),
      edit: (c) => String(c.budgets.goal.maxTurns),
      commit: (c, t) => {
        const n = posInt(t)
        return n === undefined ? 'Enter a whole number ≥ 1.' : { ...c, budgets: { ...c.budgets, goal: { ...c.budgets.goal, maxTurns: n } } }
      },
    },
    {
      id: 'goalMinutes',
      group: 'Budgets',
      label: 'Goal: max minutes',
      help: 'Wall-clock limit for one goal run.',
      kind: 'number',
      show: (c) => `${minutes(c.budgets.goal.maxDurationMs)} min`,
      edit: (c) => minutes(c.budgets.goal.maxDurationMs),
      commit: (c, t) => {
        const n = posInt(t)
        return n === undefined ? 'Enter a whole number of minutes ≥ 1.' : { ...c, budgets: { ...c.budgets, goal: { ...c.budgets.goal, maxDurationMs: n * 60_000 } } }
      },
    },
    {
      id: 'ctxWindow',
      group: 'Context',
      label: 'Context window override',
      help: 'Forces a window for EVERY model (e.g. 128k). Empty = automatic per model (set per model in /models).',
      kind: 'number',
      show: (c) => (c.context.windowTokens ? `${c.context.windowTokens.toLocaleString()} tok` : 'automatic'),
      edit: (c) => (c.context.windowTokens ? String(c.context.windowTokens) : ''),
      commit: (c, t) => {
        const v = parseTokens(t)
        if (v === undefined) return 'Use a number like 128000, 128k or 1m — empty resets to automatic.'
        const { windowTokens: _drop, ...rest } = c.context
        return { ...c, context: v === null ? rest : { ...rest, windowTokens: v } }
      },
    },
    {
      id: 'ctxOutput',
      group: 'Context',
      label: 'Output reserve',
      help: 'Tokens kept free for the model’s answer (clamped to ¼ of small windows).',
      kind: 'number',
      show: (c) => `${c.context.maxOutputTokens.toLocaleString()} tok`,
      edit: (c) => String(c.context.maxOutputTokens),
      commit: (c, t) => {
        const v = parseTokens(t)
        return v === undefined || v === null ? 'Use a number like 4096 or 8k.' : { ...c, context: { ...c.context, maxOutputTokens: v } }
      },
    },
  )
  for (const s of skills) {
    items.push({
      id: `skill-${s.name}`,
      group: 'Skills',
      label: s.name,
      help: `${s.description} (${s.source})`,
      kind: 'toggle',
      show: (c) => onOff(!c.skills.disabled.includes(s.name)),
      cycle: (c) => {
        const off = c.skills.disabled.includes(s.name)
        return { ...c, skills: { ...c.skills, disabled: off ? c.skills.disabled.filter((n) => n !== s.name) : [...c.skills.disabled, s.name] } }
      },
    })
  }
  items.push(
    { id: 'providers', group: 'Models', label: 'Providers & models…', help: 'Add providers, fetch and test models, edit context windows, set thinking levels.', kind: 'action', show: () => 'open' },
    { id: 'mcp', group: 'Tools', label: 'MCP servers…', help: 'Connect external tool servers (filesystem, GitHub, browser, docs…).', kind: 'action', show: (c) => `${Object.keys(c.mcp.servers).length} configured` },
  )
  return items
}

/**
 * /settings: every option in one place. ↑/↓ move, ←/→ or Enter change a
 * switch, Enter edits a number/text. Changes are saved the moment they are made.
 */
export function SettingsScreen({
  config,
  skills,
  maxRows = 14,
  onChange,
  onAction,
  onClose,
}: {
  config: VaraConfig
  skills: SkillRow[]
  maxRows?: number
  onChange: (config: VaraConfig) => void
  onAction: (id: string) => void
  onClose: () => void
}): React.ReactElement {
  const items = useMemo(() => settingItems(skills), [skills])
  const [cfg, setCfg, cfgR] = useSync(config)
  const [idx, setIdx, idxR] = useSync(0)
  const [editing, setEditing, editR] = useSync<string | null>(null)
  const [error, setError, errR] = useSync<string | null>(null)
  void errR

  const apply = (next: VaraConfig) => {
    setCfg(next)
    onChange(next)
  }

  useInput((raw, key) => {
    const i = Math.min(idxR.current, items.length - 1)
    const item = items[i]!
    const ed = editR.current
    if (ed !== null) {
      if (key.escape) {
        setEditing(null)
        setError(null)
        return
      }
      if (key.return) {
        const res = item.commit?.(cfgR.current, ed)
        if (typeof res === 'string') return setError(res)
        if (res) apply(res)
        setEditing(null)
        setError(null)
        return
      }
      if (key.backspace || key.delete) return setEditing((e) => (e ?? '').slice(0, -1))
      if (raw && !key.ctrl && !key.meta && raw >= ' ') setEditing((e) => (e ?? '') + raw.replace(/[\r\n]/g, ''))
      return
    }
    if (key.escape) return onClose()
    if (key.upArrow) return setIdx(Math.max(0, i - 1))
    if (key.downArrow) return setIdx(Math.min(items.length - 1, i + 1))
    if (key.pageUp) return setIdx(Math.max(0, i - maxRows))
    if (key.pageDown) return setIdx(Math.min(items.length - 1, i + maxRows))
    const dir = key.leftArrow ? -1 : 1
    if (key.leftArrow || key.rightArrow || raw === ' ' || key.return) {
      if (item.kind === 'toggle' || item.kind === 'choice') return apply(item.cycle!(cfgR.current, dir))
      if (item.kind === 'action') return onAction(item.id)
      if ((item.kind === 'number' || item.kind === 'text') && (key.return || raw === ' ')) {
        setError(null)
        return setEditing(item.edit?.(cfgR.current) ?? '')
      }
    }
  })

  const sel = Math.min(idx, items.length - 1)
  // Flat rows with group headers; the window is computed over the flat list.
  type Row = { header: string } | { item: SettingItem; i: number }
  const rows: Row[] = []
  let last = ''
  items.forEach((item, i) => {
    if (item.group !== last) {
      rows.push({ header: item.group })
      last = item.group
    }
    rows.push({ item, i })
  })
  const selRow = rows.findIndex((r) => 'item' in r && r.i === sel)
  const start = windowStart(selRow, maxRows, rows.length)
  const current = items[sel]!
  const labelWidth = Math.max(...items.map((i) => i.label.length)) + 2

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1} marginBottom={1}>
      <Text bold color={theme.brand}>
        Settings
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {rows.slice(start, start + maxRows).map((r) => {
          if ('header' in r) {
            return (
              <Text key={`h-${r.header}`} color={theme.muted} bold>
                {r.header.toUpperCase()}
              </Text>
            )
          }
          const at = r.i === sel
          const v = r.item.show(cfg)
          const editingThis = at && editing !== null
          const color = r.item.kind === 'toggle' ? (v === 'on' ? theme.ok : theme.muted) : theme.accent
          return (
            <Text key={r.item.id} wrap="truncate-end" inverse={at && !editingThis}>
              {at ? `${glyph.prompt} ` : '  '}
              {r.item.label.padEnd(labelWidth)}
              {editingThis ? (
                <Text color={theme.brand}>
                  {editing}
                  <Text inverse> </Text>
                </Text>
              ) : (
                <Text color={color}>{v}</Text>
              )}
            </Text>
          )
        })}
        {rows.length > maxRows ? (
          <Text color={theme.muted}>
            {sel + 1}/{items.length}
          </Text>
        ) : null}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={error ? theme.err : theme.muted} wrap="truncate-end">
          {error ?? current.help}
        </Text>
        <Text dimColor>
          {editing !== null ? 'type a value · Enter save · Esc cancel' : '↑↓ move · ←→/Enter/Space change · Esc close · saved automatically'}
        </Text>
      </Box>
    </Box>
  )
}
