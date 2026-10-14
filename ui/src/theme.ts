/** Colour themes. Each becomes a set of CSS variables on <html>. */

export interface Theme {
  id: string
  label: string
  dark: boolean
  bg: string
  surface: string
  surface2: string
  border: string
  text: string
  muted: string
  brand: string
  accent: string
  user: string
  ok: string
  warn: string
  err: string
  info: string
}

const t = (id: string, label: string, dark: boolean, v: Omit<Theme, 'id' | 'label' | 'dark'>): Theme => ({ id, label, dark, ...v })

export const THEMES: Theme[] = [
  t('vara', 'VARA (ember)', true, { bg: '#0f1114', surface: '#16191e', surface2: '#1d2128', border: '#2a2f38', text: '#e9e7e2', muted: '#8b919d', brand: '#F2A65A', accent: '#7FD1C2', user: '#C9A3F0', ok: '#8FD19E', warn: '#E9C46A', err: '#F07A7A', info: '#7FB0FF' }),
  t('tokyo-night', 'Tokyo Night', true, { bg: '#16161e', surface: '#1a1b26', surface2: '#202335', border: '#2f334d', text: '#c0caf5', muted: '#7982a9', brand: '#7AA2F7', accent: '#7DCFFF', user: '#BB9AF7', ok: '#9ECE6A', warn: '#E0AF68', err: '#F7768E', info: '#7AA2F7' }),
  t('catppuccin', 'Catppuccin', true, { bg: '#181825', surface: '#1e1e2e', surface2: '#262637', border: '#383850', text: '#cdd6f4', muted: '#8087a2', brand: '#CBA6F7', accent: '#89DCEB', user: '#F5C2E7', ok: '#A6E3A1', warn: '#F9E2AF', err: '#F38BA8', info: '#89B4FA' }),
  t('dracula', 'Dracula', true, { bg: '#21222c', surface: '#282a36', surface2: '#303241', border: '#44475a', text: '#f8f8f2', muted: '#8a92b8', brand: '#BD93F9', accent: '#8BE9FD', user: '#FF79C6', ok: '#50FA7B', warn: '#F1FA8C', err: '#FF5555', info: '#8BE9FD' }),
  t('nord', 'Nord', true, { bg: '#2a303c', surface: '#2e3440', surface2: '#363d4b', border: '#434c5e', text: '#e5e9f0', muted: '#8a94a8', brand: '#88C0D0', accent: '#8FBCBB', user: '#B48EAD', ok: '#A3BE8C', warn: '#EBCB8B', err: '#BF616A', info: '#81A1C1' }),
  t('gruvbox', 'Gruvbox', true, { bg: '#1d2021', surface: '#282828', surface2: '#32302f', border: '#504945', text: '#ebdbb2', muted: '#a89984', brand: '#FE8019', accent: '#8EC07C', user: '#D3869B', ok: '#B8BB26', warn: '#FABD2F', err: '#FB4934', info: '#83A598' }),
  t('rose-pine', 'Rosé Pine', true, { bg: '#14121f', surface: '#191724', surface2: '#1f1d2e', border: '#2a2740', text: '#e0def4', muted: '#908caa', brand: '#EBBCBA', accent: '#9CCFD8', user: '#C4A7E7', ok: '#9CCFD8', warn: '#F6C177', err: '#EB6F92', info: '#C4A7E7' }),
  t('light', 'Light', false, { bg: '#f6f6f4', surface: '#ffffff', surface2: '#efefec', border: '#dcdcd6', text: '#1f2328', muted: '#68707a', brand: '#C2410C', accent: '#0E7490', user: '#7C3AED', ok: '#15803D', warn: '#B45309', err: '#B91C1C', info: '#1D4ED8' }),
  t('mono', 'Monochrome', true, { bg: '#0d0d0d', surface: '#141414', surface2: '#1b1b1b', border: '#2b2b2b', text: '#ededed', muted: '#8a8a8a', brand: '#ffffff', accent: '#cfcfcf', user: '#e0e0e0', ok: '#d0d0d0', warn: '#bdbdbd', err: '#ffffff', info: '#cfcfcf' }),
]

export function findTheme(id: string | null | undefined): Theme {
  return THEMES.find((x) => x.id === id) ?? THEMES[0]!
}

const KEY = 'vara.theme'

export function savedTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved) return findTheme(saved)
    // First visit: follow the operating system.
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? findTheme('light') : THEMES[0]!
  } catch {
    return THEMES[0]!
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  const vars: Record<string, string> = {
    '--bg': theme.bg,
    '--surface': theme.surface,
    '--surface-2': theme.surface2,
    '--border': theme.border,
    '--text': theme.text,
    '--muted': theme.muted,
    '--brand': theme.brand,
    '--accent': theme.accent,
    '--user': theme.user,
    '--ok': theme.ok,
    '--warn': theme.warn,
    '--err': theme.err,
    '--info': theme.info,
  }
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
  root.style.colorScheme = theme.dark ? 'dark' : 'light'
  root.dataset['theme'] = theme.id
  try {
    localStorage.setItem(KEY, theme.id)
  } catch {
    /* not persisted */
  }
}
