import { describe, expect, it } from 'vitest'
import { COMMANDS, KEYS_HELP, helpText } from '../src/tui/commands.js'

/**
 * The interface must never advertise a shortcut or command that does not
 * exist, and /help must list every command the palette can pick.
 */

describe('command definitions', () => {
  it('every command has a slash-name and a description', () => {
    for (const c of COMMANDS) {
      expect(c.name, 'command name').toMatch(/^\/[a-z]+$/)
      expect(c.description.length, `description for ${c.name}`).toBeGreaterThan(0)
    }
  })

  it('names are unique (the palette keys by name)', () => {
    const names = COMMANDS.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('the palette command exists — dispatch and palette must agree', () => {
    expect(COMMANDS.some((c) => c.name === '/palette')).toBe(true)
  })

  it('commands the palette inserts are the ones that need arguments', () => {
    const resume = COMMANDS.find((c) => c.name === '/resume')
    expect(resume?.needsArgs).toBe(true)
    // /new opens the focused objective entry even without arguments.
    const neu = COMMANDS.find((c) => c.name === '/new')
    expect(neu?.needsArgs).toBe(false)
  })
})

describe('help text', () => {
  const help = helpText()

  it('lists every command', () => {
    for (const c of COMMANDS) expect(help, `help lists ${c.name}`).toContain(c.name)
  })

  it('documents every advertised keyboard chord', () => {
    for (const chord of ['Ctrl+C', 'Ctrl+K', 'Ctrl+N', 'Ctrl+J', 'Ctrl+B', 'Ctrl+W', 'Ctrl+G', 'Tab', 'Alt+←', 'PgUp', 'Esc', 'Enter']) {
      expect(KEYS_HELP, `KEYS_HELP mentions ${chord}`).toContain(chord)
      expect(help, `helpText mentions ${chord}`).toContain(chord)
    }
  })

  it('command hints appear in the keyboard section they reference', () => {
    for (const c of COMMANDS) {
      if (c.hint) expect(KEYS_HELP, `${c.name} hint ${c.hint}`).toContain(c.hint)
    }
  })
})
