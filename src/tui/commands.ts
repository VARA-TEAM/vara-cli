/** Single source of truth for TUI commands: /help, the palette and dispatch. */
export interface CommandDef {
  name: string
  args?: string
  description: string
  /** Keyboard shortcut hint, if any. */
  hint?: string
  /** True when picking the command should insert it into the input for the user to complete. */
  needsArgs?: boolean
}

export const COMMANDS: CommandDef[] = [
  { name: '/new', args: '[objective]', description: 'Start a new session in this directory', hint: 'Ctrl+N', needsArgs: false },
  { name: '/palette', description: 'Open the command palette', hint: 'Ctrl+K' },
  { name: '/sessions', args: '[--all]', description: 'List sessions in this directory' },
  { name: '/resume', args: '<id>', description: 'Switch to a saved session', needsArgs: true },
  { name: '/mode', args: 'plan|build', description: 'Switch the permission mode', hint: 'Tab' },
  { name: '/kind', args: 'task|goal', description: 'Switch the completion policy (task/goal)', hint: 'Ctrl+G' },
  { name: '/context', description: 'Context window, usage estimate and source' },
  { name: '/settings', description: 'Provider, model and config file location' },
  { name: '/status', description: 'Budget and progress' },
  { name: '/evidence', description: 'Recorded evidence' },
  { name: '/last', description: 'Full output of the last tool call' },
  { name: '/pause', description: 'Pause the running agent (state is saved)' },
  { name: '/stop', description: 'Stop the session permanently' },
  { name: '/quit', description: 'Save the session and exit', hint: 'Ctrl+C' },
  { name: '/help', description: 'Commands and keyboard shortcuts' },
]

export const KEYS_HELP = `Keyboard:
  Ctrl+N          new session (asks for the objective)
  Ctrl+K          command palette (type to filter)
  Ctrl+J          insert a newline in the message
  Tab             toggle PLAN / BUILD
  Alt+← / Alt+→   switch between open session tabs
  Ctrl+W          close the current tab (session stays on disk)
  Ctrl+B          toggle the status sidebar
  PgUp / PgDn     scroll the transcript
  Ctrl+G          jump to the latest entry (welcome & new-session: task ↔ goal)
  Esc             close an overlay, or press twice to interrupt the agent
  Ctrl+C          save the session and quit
  Enter           send — multi-line pasted text keeps its line breaks`

export function helpText(): string {
  const width = Math.max(...COMMANDS.map((c) => (c.name + (c.args ? ' ' + c.args : '')).length))
  const lines = COMMANDS.map((c) => {
    const head = c.name + (c.args ? ' ' + c.args : '')
    const hint = c.hint ? `  [${c.hint}]` : ''
    return `  ${head.padEnd(width + 2)}${c.description}${hint}`
  })
  return `${KEYS_HELP}\n\nCommands:\n${lines.join('\n')}\n\nAny other text is sent to the agent as a follow-up instruction.`
}
