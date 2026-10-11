import { beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import { formatElapsed } from '../src/tui/format.js'
import { appendEntry, replayTranscript, resumeBanner } from '../src/tui/history.js'
import { truncate, firstLine, type Entry } from '../src/tui/entries.js'
import { nextTabId, type TabInfo } from '../src/tui/tabs.js'

let createSession: typeof import('../src/core/session.js').createSession
let CreateSessionInput: typeof import('../src/core/session.js').CreateSessionInput

beforeAll(async () => {
  const s = await import('../src/core/session.js')
  createSession = s.createSession
  CreateSessionInput = s.CreateSessionInput
})

function makeSession(transcript: Array<Record<string, unknown>> = []) {
  const session = createSession(
    CreateSessionInput.parse({ kind: 'task', mode: 'build', objective: 'Replay me', cwd: process.cwd() }),
    DEFAULT_CONFIG,
  )
  for (const m of transcript) {
    session.transcript.push({ at: new Date().toISOString(), ...m } as never)
  }
  return session
}

const note = (text: string, group?: string): Entry => ({ kind: 'note', text, color: 'yellow', group })

describe('formatElapsed', () => {
  it('renders seconds, minutes and hours readably', () => {
    expect(formatElapsed(45)).toBe('45s')
    expect(formatElapsed(265)).toBe('4m 25s')
    // The bug this replaced: 48861s was shown raw — unreadable at a glance.
    expect(formatElapsed(48861)).toBe('13h 34m')
  })

  it('handles zero, negatives and garbage without throwing', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(-5)).toBe('0s')
    expect(formatElapsed(Number.NaN)).toBe('0s')
  })

  it('rolls days over at 24h', () => {
    expect(formatElapsed(86400)).toBe('1d 0h')
    expect(formatElapsed(90000)).toBe('1d 1h')
  })
})

describe('appendEntry (note collapsing)', () => {
  it('appends distinct entries in order', () => {
    const a: Entry = { kind: 'user', text: 'hello' }
    const b: Entry = { kind: 'assistant', text: 'hi' }
    expect(appendEntry([a], b)).toEqual([a, b])
  })

  it('drops an identical consecutive ungrouped note (pure duplicate)', () => {
    const first = note('verification failed: exit 1')
    const result = appendEntry([first], note('verification failed: exit 1'))
    expect(result).toHaveLength(1)
  })

  it('replaces the previous entry when a grouped note repeats its group', () => {
    // The bug this replaced: toggling PLAN/BUILD 12 times stacked 12 lines.
    const first = appendEntry([], note('mode → PLAN (applies from the next turn)', 'mode'))
    const second = appendEntry(first, note('mode → BUILD (applies from the next turn)', 'mode'))
    expect(second).toHaveLength(1)
    expect(second[0]).toMatchObject({ kind: 'note', text: expect.stringContaining('BUILD') })
  })

  it('does not replace when the previous entry belongs to another group or kind', () => {
    const user: Entry = { kind: 'user', text: 'check this' }
    const afterUser = appendEntry([user], note('mode → PLAN', 'mode'))
    expect(afterUser).toHaveLength(2)

    const other = appendEntry(afterUser, note('follow-up applied at turn 4', 'queue'))
    expect(other).toHaveLength(3)
  })

  it('caps the list by dropping the oldest entries', () => {
    let list: Entry[] = []
    for (let i = 0; i < 10; i++) list = appendEntry(list, { kind: 'user', text: `m${i}` }, 5)
    expect(list).toHaveLength(5)
    expect(list[0]).toMatchObject({ text: 'm5' })
  })
})

describe('replayTranscript', () => {
  it('maps user and assistant text into entries, skipping system messages', () => {
    const session = makeSession([
      { role: 'user', content: 'build it' },
      { role: 'system', content: 'internal instructions' },
      { role: 'assistant', content: 'working on it' },
    ])
    const entries = replayTranscript(session)
    expect(entries.map((e) => e.kind)).toEqual(['user', 'assistant'])
    expect(entries[0]).toMatchObject({ text: 'build it' })
  })

  it('attaches tool output to its tool call entry via toolCallId', () => {
    const session = makeSession([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'run_command', arguments: '{"cmd":"ls"}' }],
      },
      { role: 'tool', content: 'file.txt', toolCallId: 'c1', toolName: 'run_command' },
    ])
    const entries = replayTranscript(session)
    const tool = entries.find((e) => e.kind === 'tool')
    expect(tool).toMatchObject({ name: 'run_command', output: 'file.txt' })
    // The tool result must not appear as a second entry.
    expect(entries).toHaveLength(2)
  })

  it('keeps tool calls even when the assistant text is empty', () => {
    const session = makeSession([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }],
      },
    ])
    const entries = replayTranscript(session)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'tool', name: 'read_file' })
  })

  it('mirrors the engine trim: outputs older than 30 messages from the end are gone', () => {
    const transcript: Array<Record<string, unknown>> = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'old', name: 'run_command', arguments: '{}' }] },
      { role: 'tool', content: 'stale output', toolCallId: 'old', toolName: 'run_command' },
    ]
    for (let i = 0; i < 28; i++) transcript.push({ role: 'assistant', content: `filler ${i}` })
    transcript.push({ role: 'assistant', content: '', toolCalls: [{ id: 'new', name: 'run_command', arguments: '{}' }] })
    transcript.push({ role: 'tool', content: 'fresh output', toolCallId: 'new', toolName: 'run_command' })

    const entries = replayTranscript(makeSession(transcript))
    const tools = entries.filter((e): e is Extract<Entry, { kind: 'tool' }> => e.kind === 'tool')
    expect(tools).toHaveLength(2)
    // Old output was trimmed by the engine to save context — replay must not
    // fabricate it back.
    expect(tools[0]?.output).toBeUndefined()
    expect(tools[1]?.output).toBe('fresh output')
  })

  it('caps replay size so a huge session cannot freeze the view', () => {
    const transcript: Array<Record<string, unknown>> = []
    for (let i = 0; i < 400; i++) transcript.push({ role: 'user', content: `m${i}` })
    const entries = replayTranscript(makeSession(transcript), 150)
    expect(entries).toHaveLength(150)
    expect(entries[0]).toMatchObject({ text: 'm250' })
  })

  it('resumeBanner states the session id and turn count', () => {
    const session = makeSession([{ role: 'user', content: 'x' }])
    session.usage.turns = 60
    const banner = resumeBanner(session)
    expect(banner).toMatchObject({ kind: 'note' })
    expect(banner.text).toContain(session.id)
    expect(banner.text).toContain('60 turns')
  })
})

describe('tab cycling', () => {
  const tabs: TabInfo[] = [
    { id: 'a', label: 'one', state: 'completed' },
    { id: 'b', label: 'two', state: 'running' },
    { id: 'c', label: 'three', state: 'paused' },
  ]

  it('moves forward and backward with wrap-around', () => {
    expect(nextTabId(tabs, 'a', 1)).toBe('b')
    expect(nextTabId(tabs, 'c', 1)).toBe('a')
    expect(nextTabId(tabs, 'a', -1)).toBe('c')
  })

  it('is stable for empty lists and unknown ids', () => {
    expect(nextTabId([], 'a', 1)).toBe('a')
    expect(nextTabId(tabs, 'missing', 1)).toBe('a')
  })
})

describe('entry text helpers', () => {
  it('truncate appends the ellipsis only when cutting', () => {
    expect(truncate('short', 10)).toBe('short')
    expect(truncate('abcdefghij', 5)).toBe('abcd…')
  })

  it('firstLine stops at the newline', () => {
    expect(firstLine('a\nb\nc')).toBe('a')
  })
})
