// The one source of VARA's design tokens. `node scripts/build-tokens.mjs` writes it, as plain CSS, to every surface that
// needs it (landing page, gateway pages, owner console). A test fails when a copy drifts, so no page invents its own colour.
//
// Names say what a colour is FOR (text, line, card), not what it looks like, so a theme only has to answer each question once.
// Themes: system (follows the device), light, dark. Accents: seven, one is chosen. Density: comfortable or compact.

export const FONT_UI = '"Bricolage Grotesque", "IBM Plex Sans Arabic", "Segoe UI", system-ui, sans-serif'
export const FONT_CODE = 'ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace'

// What each theme says. Every key exists in both, so a missing value is a bug the test can see.
export const THEMES = {
  dark: {
    '--c-bg': '#0B0916',
    '--c-bg-nav': '#0F0C1D',
    '--c-bg-card': '#14102A',
    '--c-bg-raised': '#1B1636',
    '--c-bg-sunken': '#090714',
    '--c-fill-1': 'rgb(244 241 255 / .05)',
    '--c-fill-2': 'rgb(244 241 255 / .09)',
    '--c-fill-3': 'rgb(244 241 255 / .14)',
    '--c-text': '#EEEAF8',
    '--c-text-2': '#B8B2D0',
    '--c-text-3': '#8F89AB',
    '--c-text-off': '#5F5A7A',
    '--c-line': 'rgb(244 241 255 / .11)',
    '--c-line-strong': 'rgb(244 241 255 / .2)',
    '--c-ok': '#4CC38A',
    '--c-warn': '#F0A64B',
    '--c-bad': '#F2788A',
    '--c-paper': '#14102A',
    '--c-paper-ink': '#EEEAF8',
    '--c-paper-muted': '#A8A2C4',
    '--c-paper-line': 'rgb(244 241 255 / .18)',
    '--c-shadow': 'rgb(0 0 0 / .5)',
    '--c-scroll': '#3A3262',
  },
  light: {
    '--c-bg': '#F7F5FC',
    '--c-bg-nav': '#F0EDF8',
    '--c-bg-card': '#FFFFFF',
    '--c-bg-raised': '#FFFFFF',
    '--c-bg-sunken': '#F1EEF9',
    '--c-fill-1': 'rgb(34 24 80 / .04)',
    '--c-fill-2': 'rgb(34 24 80 / .07)',
    '--c-fill-3': 'rgb(34 24 80 / .11)',
    '--c-text': '#16122A',
    '--c-text-2': '#4A4468',
    '--c-text-3': '#6E6890',
    '--c-text-off': '#A7A2BF',
    '--c-line': 'rgb(22 18 42 / .11)',
    '--c-line-strong': 'rgb(22 18 42 / .22)',
    '--c-ok': '#17805A',
    '--c-warn': '#9A5B00',
    '--c-bad': '#C0304A',
    '--c-paper': '#FFFFFF',
    '--c-paper-ink': '#16122A',
    '--c-paper-muted': '#625C7E',
    '--c-paper-line': '#DAD4F2',
    '--c-shadow': 'rgb(40 30 90 / .18)',
    '--c-scroll': '#CBC5E6',
  },
}

// Seven accents. `ink` is the text on a filled accent (one colour, or one per theme); every pair is at least 4.5:1.
export const inkOf = (a, mode) => (typeof a.ink === 'string' ? a.ink : a.ink[mode])
export const ACCENTS = {
  violet: { dark: '#7A5AF8', light: '#6A44E8', ink: '#FFFFFF' },
  blue: { dark: '#2F6FEA', light: '#2468E0', ink: '#FFFFFF' },
  green: { dark: '#17805A', light: '#17805A', ink: '#FFFFFF' },
  orange: { dark: '#E9803A', light: '#D56C26', ink: '#1A0E05' },
  pink: { dark: '#C2418A', light: '#BE3F86', ink: '#FFFFFF' },
  yellow: { dark: '#E8B843', light: '#C99A1E', ink: '#1A1405' },
  graphite: { dark: '#D8D5E6', light: '#2B2740', ink: { dark: '#14110A', light: '#FFFFFF' } },
}

export const DENSITY = {
  comfortable: { '--control-h': '48px', '--row-h': '44px', '--pad': '18px', '--gap': '16px', '--fs-body': '16px' },
  compact: { '--control-h': '40px', '--row-h': '36px', '--pad': '14px', '--gap': '12px', '--fs-body': '15px' },
}

const decls = (o) => Object.entries(o).map(([k, v]) => `${k}:${v}`).join(';')
const accentRules = (mode) =>
  Object.entries(ACCENTS).map(([n, a]) => `[data-accent="${n}"]{--c-accent:${a[mode]};--c-accent-ink:${inkOf(a, mode)};--c-accent-soft:color-mix(in srgb,${a[mode]} 16%,transparent);--c-accent-line:color-mix(in srgb,${a[mode]} 45%,transparent)}`).join('\n')

/** The stylesheet every surface carries. `:root` is dark so the page is right before any attribute is set. */
export function tokensCss() {
  return `/* Generated from design/tokens.mjs by scripts/build-tokens.mjs. Do not edit. */
:root{color-scheme:dark;${decls(THEMES.dark)};--c-accent:${ACCENTS.violet.dark};--c-accent-ink:${inkOf(ACCENTS.violet, 'dark')};--c-accent-soft:color-mix(in srgb,var(--c-accent) 16%,transparent);--c-accent-line:color-mix(in srgb,var(--c-accent) 45%,transparent);--r-sm:8px;--r-md:10px;--r-lg:14px;--r-xl:22px;--font-ui:${FONT_UI};--font-code:${FONT_CODE};${decls(DENSITY.comfortable)};--ease-out:cubic-bezier(.16,1,.3,1)}
:root[data-theme="light"]{color-scheme:light;${decls(THEMES.light)}}
@media (prefers-color-scheme:light){:root[data-theme="system"]{color-scheme:light;${decls(THEMES.light)}}}
${accentRules('dark')}
${accentRules('light').split('\n').map((r) => `:root[data-theme="light"]${r}`).join('\n')}
@media (prefers-color-scheme:light){${accentRules('light').split('\n').map((r) => `:root[data-theme="system"]${r}`).join('\n')}}
:root[data-density="compact"]{${decls(DENSITY.compact)}}
`
}
