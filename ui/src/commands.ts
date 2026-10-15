import { createContext, useContext, useEffect, useRef } from 'react'

/**
 * One list of things you can do, shown three ways: typed as `/command` in the message box,
 * searched in the command palette (Ctrl K), and listed in Help. A command that is not allowed
 * for this person is simply not in the list — never shown and then refused.
 */
export interface Cmd {
  id: string
  title: string
  description?: string
  /** Typed as `/slash` in the composer; also what the palette inserts when the command takes an argument. */
  slash?: string
  /** Placeholder for the argument, e.g. `plan|build`. Without it the command runs at once. */
  args?: string
  /** Offered values for the argument (shown as the palette's completions). */
  options?: string[]
  group: 'session' | 'go' | 'settings' | 'skill' | 'theme' | 'layout'
  shortcut?: string
  run: (arg: string) => void | Promise<void>
}

/** A registry that does not re-render anybody: the palette reads it when it opens. */
export interface Registry {
  set(owner: string, cmds: Cmd[]): void
  all(): Cmd[]
}

export function makeRegistry(): Registry {
  const by = new Map<string, Cmd[]>()
  return {
    set: (owner, cmds) => void (cmds.length ? by.set(owner, cmds) : by.delete(owner)),
    all: () => [...by.values()].flat(),
  }
}

export const RegistryContext = createContext<Registry>(makeRegistry())

/** Offer commands for as long as this component is on screen. */
export function useRegisterCommands(owner: string, cmds: Cmd[]): void {
  const reg = useContext(RegistryContext)
  const latest = useRef(cmds)
  latest.current = cmds
  // Registered on every render (cheap, no state): the palette always sees current closures.
  reg.set(owner, cmds)
  useEffect(() => () => reg.set(owner, []), [reg, owner])
}

/** Split `/name rest of the line` into its parts, or null when it is not a command line. */
export function parseSlash(text: string): { name: string; arg: string } | null {
  const m = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  return m ? { name: m[1]!.toLowerCase(), arg: (m[2] ?? '').trim() } : null
}

export function matchCommands(cmds: Cmd[], query: string): Cmd[] {
  const q = query.trim().toLowerCase()
  if (!q) return cmds
  const score = (c: Cmd): number => {
    const hay = `${c.title} ${c.slash ?? ''} ${c.description ?? ''}`.toLowerCase()
    if ((c.slash ?? '').toLowerCase() === q) return 0
    if ((c.slash ?? '').toLowerCase().startsWith(q) || c.title.toLowerCase().startsWith(q)) return 1
    if (hay.includes(q)) return 2
    // every word of the query appears somewhere
    return q.split(/\s+/).every((w) => hay.includes(w)) ? 3 : 99
  }
  return cmds
    .map((c) => ({ c, s: score(c) }))
    .filter((x) => x.s < 99)
    .sort((a, b) => a.s - b.s)
    .map((x) => x.c)
}
