/**
 * Terminal ↔ browser parity, as data. `tests/ui-workbench.test.ts` checks it three ways:
 *   1. every command in `src/tui/commands.ts` and every key action in `src/tui/keymap.ts` has a row here;
 *   2. every `slash` named here exists in the browser's command list (a literal `slash: '…'` in ui/src);
 *   3. the parity tables in docs/ARCHITECTURE.md and docs/ar/ARCHITECTURE.md list the same commands.
 * `same` = the same thing; `adapted` = the same job done the browser's way; `na` = it makes no sense in a browser;
 * `planned` = the terminal has it and the browser does not yet (its web side lands with another change; the
 * test fails the moment a `slash` of that name exists, so the row cannot be forgotten).
 */
export type ParityStatus = 'same' | 'adapted' | 'na' | 'planned'

export interface CommandParity {
  /** The terminal command, with its slash. */
  tui: string
  /** The command typed in the browser (without slash), when the same name exists. */
  slash?: string
  status: ParityStatus
  /** Where it lives in the browser, in plain words (also the English docs text). */
  web: string
}

export const COMMAND_PARITY: CommandParity[] = [
  { tui: '/new', slash: 'new', status: 'same', web: 'New session tab (Ctrl Shift O); the + button in the tab strip' },
  { tui: '/palette', slash: 'palette', status: 'same', web: 'Command palette (Ctrl K)' },
  { tui: '/sessions', slash: 'sessions', status: 'same', web: 'Sidebar filter and the "this folder / all folders" switch; /sessions --all' },
  { tui: '/resume', slash: 'resume', status: 'same', web: 'Open by the start of an id, or click a session in the sidebar' },
  { tui: '/mode', slash: 'mode', status: 'same', web: 'Mode menu in the message box; Alt M flips plan/build' },
  { tui: '/kind', slash: 'kind', status: 'adapted', web: 'In a session: task or goal; Auto is chosen on the start screen' },
  { tui: '/providers', slash: 'providers', status: 'same', web: 'Settings → Models & providers' },
  { tui: '/provider', slash: 'provider', status: 'same', web: 'Makes another provider (and optionally a model) the default' },
  { tui: '/model', slash: 'model', status: 'same', web: 'Model menu in the message box' },
  { tui: '/models', slash: 'models', status: 'same', web: 'Settings → Models: status, context and thinking per model, with a filter' },
  { tui: '/context', slash: 'context', status: 'same', web: 'Side panel → Cost: window, usage and where the size comes from' },
  { tui: '/settings', slash: 'settings', status: 'same', web: 'Settings (Ctrl O)' },
  { tui: '/theme', slash: 'theme', status: 'same', web: 'Nine themes; Settings → Look and feel' },
  { tui: '/agents', slash: 'agents', status: 'same', web: 'Side panel → Agents (Ctrl Shift A): roles, status, trace, calls and cost, reports; cancel one agent or all' },
  { tui: '/mcp', slash: 'mcp', status: 'same', web: 'Settings → MCP servers (add, switch, reconnect, remove)' },
  { tui: '/connectors', slash: 'connectors', status: 'same', web: 'Settings → Connectors (guided token entry)' },
  { tui: '/think', slash: 'think', status: 'same', web: 'Thinking menu in the message box' },
  { tui: '/gateway', slash: 'gateway', status: 'same', web: '/gateway opens Settings → Gateways: the whole setup (token, pairing code, on/off) on one page' },
  { tui: '/undo', slash: 'undo', status: 'same', web: '/undo in the message box or the palette' },
  { tui: '/checkpoints', slash: 'checkpoints', status: 'planned', web: 'The list is not shown in the browser yet; /undo works' },
  { tui: '/compact', slash: 'compact', status: 'same', web: '/compact in the message box or the palette; auto-compact runs on its own' },
  { tui: '/autocompact', slash: 'autocompact', status: 'planned', web: 'On by default; the web switch for it is not built yet (config context.autoCompact)' },
  { tui: '/cost', slash: 'cost', status: 'same', web: 'Side panel → Cost, and the status bar' },
  { tui: '/limit', status: 'planned', web: 'Not in the browser yet: arrives with the cost-engine board' },
  { tui: '/savings', status: 'planned', web: 'Not in the browser yet: the Cost tab shows this session’s savings; the 7-day and all-time view arrives with the cost-engine board' },
  { tui: '/route', status: 'planned', web: 'Not in the browser yet: arrives with the cost-engine board' },
  { tui: '/attach', slash: 'attach', status: 'same', web: 'Clip button, drag and drop, paste; /attach opens the file picker' },
  { tui: '/preview', slash: 'preview', status: 'same', web: 'Bottom dock → Preview; /preview start <command>, stop, logs' },
  { tui: '/export', slash: 'export', status: 'adapted', web: 'Downloads the conversation as a markdown file (the browser picks the folder)' },
  { tui: '/skills', slash: 'skills', status: 'same', web: 'Settings → Skills (list, create, edit, switch; skills the agent proposed wait at the top for your approval)' },
  { tui: '/memory', slash: 'memory', status: 'same', web: 'Settings → Memory (edit both note files, switch memory on or off)' },
  { tui: '/skill', slash: 'skill', status: 'same', web: 'Makes the agent apply a skill now; each skill is also its own /name' },
  { tui: '/status', slash: 'status', status: 'same', web: 'Side panel → Proof: turns, calls, time limit, context, evidence' },
  { tui: '/evidence', slash: 'evidence', status: 'same', web: 'Side panel → Proof: the evidence timeline' },
  { tui: '/last', slash: 'last', status: 'same', web: 'Bottom dock → Output, scrolled to the last tool call' },
  { tui: '/pause', slash: 'pause', status: 'same', web: 'Pause button; Esc twice' },
  { tui: '/enable', slash: 'enable', status: 'same', web: 'Side panel → Tools, per session; /enable <skill|server>' },
  { tui: '/disable', slash: 'disable', status: 'same', web: 'Side panel → Tools, per session; /disable <skill|server>' },
  { tui: '/approve', slash: 'approve', status: 'same', web: 'Approval cards above the message box; /approve [id]' },
  { tui: '/deny', slash: 'deny', status: 'same', web: 'Approval cards above the message box; /deny [id]' },
  { tui: '/stop', slash: 'stop', status: 'same', web: 'Session menu → Stop (the page stays open)' },
  { tui: '/quit', status: 'na', web: 'Close the tab; the session is saved as it runs (guests: Sign out)' },
  { tui: '/help', slash: 'help', status: 'same', web: 'Help and shortcuts (commands and both keyboards)' },
]

export interface KeyParity {
  /** The terminal's key action (`type` in src/tui/keymap.ts). */
  action: string
  status: ParityStatus
  /** Plain-words description of the browser equivalent. */
  web: string
}

export const KEY_PARITY: KeyParity[] = [
  { action: 'quit', status: 'na', web: 'Not needed: the host keeps running; close the tab' },
  { action: 'overlay-input', status: 'same', web: 'Dialogs and menus own the keyboard while open' },
  { action: 'close-overlay', status: 'same', web: 'Esc closes a dialog or menu' },
  { action: 'open-palette', status: 'same', web: 'Ctrl K' },
  { action: 'open-settings', status: 'same', web: 'Ctrl O' },
  { action: 'open-home', status: 'adapted', web: 'Ctrl Shift O (the browser keeps Ctrl N)' },
  { action: 'close-home', status: 'same', web: 'Close the tab, or open a session' },
  { action: 'home-move', status: 'same', web: 'Tab and arrow keys through the recent list' },
  { action: 'arm-interrupt', status: 'same', web: 'Esc once in the message box while an agent runs' },
  { action: 'interrupt', status: 'same', web: 'Esc a second time pauses it' },
  { action: 'toggle-sidebar', status: 'adapted', web: 'Ctrl B hides the sidebar; Ctrl . the side panel' },
  { action: 'close-tab', status: 'adapted', web: 'Alt W (the browser keeps Ctrl W)' },
  { action: 'switch-tab', status: 'same', web: 'Alt ← / Alt →; Alt Shift ← / → moves a tab' },
  { action: 'scroll', status: 'same', web: 'Page Up / Page Down in the conversation' },
  { action: 'scroll-line', status: 'same', web: 'Arrow keys and the wheel' },
  { action: 'complete', status: 'same', web: 'The / and @ menus in the message box (Tab or Enter picks)' },
  { action: 'click', status: 'same', web: 'Click (the browser is mouse-first)' },
  { action: 'wheel', status: 'same', web: 'Mouse wheel and touch scrolling' },
  { action: 'scroll-latest', status: 'same', web: 'Ctrl G, or the "New messages" button' },
  { action: 'toggle-mode', status: 'adapted', web: 'Alt M (Tab stays for moving focus)' },
  { action: 'toggle-kind', status: 'adapted', web: 'The Kind menu on the start screen' },
  { action: 'submit', status: 'same', web: 'Enter' },
  { action: 'newline', status: 'same', web: 'Shift Enter or Ctrl J' },
  { action: 'delete-back', status: 'same', web: 'Backspace (native text field)' },
  { action: 'text', status: 'same', web: 'Typing and pasting (native text field)' },
  { action: 'none', status: 'same', web: 'No effect' },
]

export interface ScreenParity {
  /** A terminal screen or one of its keys. */
  tui: string
  status: ParityStatus
  web: string
}

/** Keys inside the terminal's full-screen forms (providers, MCP, sessions) and where each lives in the browser. */
export const SCREEN_PARITY: ScreenParity[] = [
  { tui: 'Providers: Enter use · k key · d remove', status: 'same', web: 'Settings → Models: Use, key field, remove provider' },
  { tui: 'Models: t test · a test all · r refresh', status: 'same', web: 'Test, Test all, Fetch models' },
  { tui: 'Models: c context · h thinking', status: 'same', web: 'Context dialog, Thinking menu on each model' },
  { tui: 'Models: n add · x remove', status: 'same', web: 'Add a model field, Remove' },
  { tui: 'Models: / filter', status: 'same', web: 'Filter field above the model list (more than six models)' },
  { tui: 'MCP: Enter add · t on/off · r reconnect · d remove', status: 'same', web: 'Settings → MCP servers: Add, switch, Reconnect, Remove' },
  { tui: 'Sessions overlay: type to filter · Tab scope · Enter open', status: 'same', web: 'Sidebar filter · folder/all switch · Enter opens the first match' },
  { tui: 'Settings: theme, mode, verify command, cheap model, budgets, context, skills', status: 'same', web: 'Settings → Agent, Skills, Look and feel' },
  { tui: 'Start screen: recent sessions, Ctrl N tabs', status: 'same', web: 'Home page and session tabs' },
]
