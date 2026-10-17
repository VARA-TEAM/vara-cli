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

/** The three themes whose colours come from the shared design tokens (bridge.css); the rest set their own. */
const FROM_TOKENS = new Set(['vara', 'light', 'system'])

export const THEMES: Theme[] = [
  t('system', 'System', true, { bg: '#0B0916', surface: '#14102A', surface2: '#1B1636', border: '#2B2742', text: '#EEEAF8', muted: '#8F89AB', brand: '#7A5AF8', accent: '#BCAEFF', user: '#D6A8F0', ok: '#4CC38A', warn: '#F0A64B', err: '#F2788A', info: '#7DAEE8' }),
  t('vara', 'VARA', true, { bg: '#09080E', surface: '#110F19', surface2: '#19162A', border: '#272241', text: '#EEEAF8', muted: '#9993B3', brand: '#7A5AF8', accent: '#BCAEFF', user: '#D6A8F0', ok: '#7FCB9A', warn: '#F0A64B', err: '#F2788A', info: '#7DAEE8' }),
  t('tokyo-night', 'Tokyo Night', true, { bg: '#16161e', surface: '#1a1b26', surface2: '#202335', border: '#2f334d', text: '#c0caf5', muted: '#7982a9', brand: '#7AA2F7', accent: '#7DCFFF', user: '#BB9AF7', ok: '#9ECE6A', warn: '#E0AF68', err: '#F7768E', info: '#7AA2F7' }),
  t('catppuccin', 'Catppuccin', true, { bg: '#181825', surface: '#1e1e2e', surface2: '#262637', border: '#383850', text: '#cdd6f4', muted: '#8087a2', brand: '#CBA6F7', accent: '#89DCEB', user: '#F5C2E7', ok: '#A6E3A1', warn: '#F9E2AF', err: '#F38BA8', info: '#89B4FA' }),
  t('dracula', 'Dracula', true, { bg: '#21222c', surface: '#282a36', surface2: '#303241', border: '#44475a', text: '#f8f8f2', muted: '#8a92b8', brand: '#BD93F9', accent: '#8BE9FD', user: '#FF79C6', ok: '#50FA7B', warn: '#F1FA8C', err: '#FF5555', info: '#8BE9FD' }),
  t('nord', 'Nord', true, { bg: '#2a303c', surface: '#2e3440', surface2: '#363d4b', border: '#434c5e', text: '#e5e9f0', muted: '#8a94a8', brand: '#88C0D0', accent: '#8FBCBB', user: '#B48EAD', ok: '#A3BE8C', warn: '#EBCB8B', err: '#BF616A', info: '#81A1C1' }),
  t('gruvbox', 'Gruvbox', true, { bg: '#1d2021', surface: '#282828', surface2: '#32302f', border: '#504945', text: '#ebdbb2', muted: '#a89984', brand: '#FE8019', accent: '#8EC07C', user: '#D3869B', ok: '#B8BB26', warn: '#FABD2F', err: '#FB4934', info: '#83A598' }),
  t('rose-pine', 'Rosé Pine', true, { bg: '#14121f', surface: '#191724', surface2: '#1f1d2e', border: '#2a2740', text: '#e0def4', muted: '#908caa', brand: '#EBBCBA', accent: '#9CCFD8', user: '#C4A7E7', ok: '#9CCFD8', warn: '#F6C177', err: '#EB6F92', info: '#C4A7E7' }),
  t('light', 'Light', false, { bg: '#F5F3FB', surface: '#FFFFFF', surface2: '#ECE8F7', border: '#DCD6EE', text: '#16122A', muted: '#625C7E', brand: '#6A44E8', accent: '#5A3FC0', user: '#9A3FB8', ok: '#1E7A4B', warn: '#9A5B00', err: '#B8322A', info: '#1D5FC4' }),
  t('mono', 'Monochrome', true, { bg: '#0d0d0d', surface: '#141414', surface2: '#1b1b1b', border: '#2b2b2b', text: '#ededed', muted: '#8a8a8a', brand: '#ffffff', accent: '#cfcfcf', user: '#e0e0e0', ok: '#d0d0d0', warn: '#bdbdbd', err: '#ffffff', info: '#cfcfcf' }),
]

export function findTheme(id: string | null | undefined): Theme {
  return THEMES.find((x) => x.id === id) ?? THEMES[0]!
}

const KEY = 'vara.theme'

export function savedTheme(): Theme {
  try {
    // First visit: 'system' follows the operating system.
    return findTheme(localStorage.getItem(KEY))
  } catch {
    return THEMES[0]!
  }
}

/** Black or white text, whichever reads better on the given colour. */
function readable(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  const lin = (c: number): number => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const y = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
  return y > 0.3 ? '#14110A' : '#FFFFFF'
}

const VAR_NAMES = ['--bg', '--surface', '--surface-2', '--border', '--text', '--muted', '--brand', '--accent', '--user', '--ok', '--warn', '--err', '--info']

export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (FROM_TOKENS.has(theme.id)) {
    for (const k of VAR_NAMES) root.style.removeProperty(k)
    root.style.removeProperty('--on-brand')
    root.style.removeProperty('color-scheme')
    root.dataset['theme'] = theme.id
    try {
      localStorage.setItem(KEY, theme.id)
    } catch {
      /* not persisted */
    }
    return
  }
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
  root.style.setProperty('--on-brand', readable(theme.brand))
  root.style.colorScheme = theme.dark ? 'dark' : 'light'
  root.dataset['theme'] = theme.id
  try {
    localStorage.setItem(KEY, theme.id)
  } catch {
    /* not persisted */
  }
}

/** Typefaces. The first is VARA's own and the default; the others are for people who prefer their system's look. */
export interface FontChoice { id: string; label: string; sample: string }
export const FONTS: FontChoice[] = [
  { id: 'vara', label: 'VARA', sample: 'Bricolage Grotesque' },
  { id: 'system', label: 'System', sample: 'Segoe UI, SF Pro' },
  { id: 'classic', label: 'Classic', sample: 'Serif headings' },
  { id: 'mono', label: 'Mono', sample: 'Terminal' },
]
const FONT_KEY = 'vara.font'

export function savedFont(): string {
  try {
    const f = localStorage.getItem(FONT_KEY)
    return FONTS.some((x) => x.id === f) ? f! : 'vara'
  } catch {
    return 'vara'
  }
}

export function applyFont(id: string): void {
  document.documentElement.dataset['font'] = id
  try {
    localStorage.setItem(FONT_KEY, id)
  } catch {
    /* not persisted */
  }
}

/** Accent colour and density: the same seven accents and two densities as the website, the platform pages and the owner console. */
export const ACCENT_IDS = ['violet', 'blue', 'green', 'orange', 'pink', 'yellow', 'graphite'] as const
export type AccentId = (typeof ACCENT_IDS)[number]
export const DENSITY_IDS = ['comfortable', 'compact'] as const
export type DensityId = (typeof DENSITY_IDS)[number]

export function savedAccent(): AccentId {
  try {
    const v = localStorage.getItem('vara.accent')
    return (ACCENT_IDS as readonly string[]).includes(v ?? '') ? (v as AccentId) : 'violet'
  } catch {
    return 'violet'
  }
}
export function applyAccent(id: AccentId): void {
  document.documentElement.dataset['accent'] = id
  try {
    localStorage.setItem('vara.accent', id)
  } catch {
    /* not persisted */
  }
}
export function savedDensity(): DensityId {
  try {
    return localStorage.getItem('vara.density') === 'compact' ? 'compact' : 'comfortable'
  } catch {
    return 'comfortable'
  }
}
export function applyDensity(id: DensityId): void {
  document.documentElement.dataset['density'] = id
  try {
    localStorage.setItem('vara.density', id)
  } catch {
    /* not persisted */
  }
}
