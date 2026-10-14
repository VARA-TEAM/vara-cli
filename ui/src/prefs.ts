import { createContext, useContext } from 'react'

/** Interface choices that belong to this browser (not to the host): what to show, not what VARA does. */
export interface Prefs {
  /** Show the model's reasoning stream while it works (owner only; the host never sends it to guests). */
  showThinking: boolean
  /** Show the one-line summary (path, command) on each tool card. */
  toolDetails: boolean
  /** Open the details panel by default on wide screens. */
  panel: boolean
}

export const DEFAULT_PREFS: Prefs = { showThinking: true, toolDetails: true, panel: true }
const KEY = 'vara.prefs'

export function savedPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>
    return {
      showThinking: typeof raw.showThinking === 'boolean' ? raw.showThinking : DEFAULT_PREFS.showThinking,
      toolDetails: typeof raw.toolDetails === 'boolean' ? raw.toolDetails : DEFAULT_PREFS.toolDetails,
      panel: typeof raw.panel === 'boolean' ? raw.panel : DEFAULT_PREFS.panel,
    }
  } catch {
    return DEFAULT_PREFS
  }
}

export function storePrefs(p: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* private mode: the choice lasts for this tab only */
  }
}

export const PrefsContext = createContext<{ prefs: Prefs; setPrefs: (p: Partial<Prefs>) => void }>({ prefs: DEFAULT_PREFS, setPrefs: () => {} })
export const usePrefs = (): { prefs: Prefs; setPrefs: (p: Partial<Prefs>) => void } => useContext(PrefsContext)
