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
  { name: '/new', args: '[message]', description: 'Open the start screen in a new tab (nothing required)', hint: 'Ctrl+N', needsArgs: false },
  { name: '/palette', description: 'Open the command palette', hint: 'Ctrl+K' },
  { name: '/sessions', args: '[--all]', description: 'List sessions in this directory' },
  { name: '/resume', args: '<id>', description: 'Switch to a saved session', needsArgs: true },
  { name: '/mode', args: 'plan|build|<custom>', description: 'Switch the mode (your own modes: config.json → "modes", or Settings in the web UI)', hint: 'Tab' },
  { name: '/kind', args: 'auto|task|goal', description: 'auto = the agent reads each message; task/goal pins it', hint: 'Ctrl+G' },
  { name: '/providers', description: 'Add providers, fetch models, test them (green = works)' },
  { name: '/provider', args: '<name> [model]', description: 'Switch provider', needsArgs: true },
  { name: '/model', args: '[model-id]', description: 'Switch model (no argument: pick from a list)', needsArgs: false },
  { name: '/models', description: 'Models of the current provider with status and context' },
  { name: '/context', description: 'Context window, usage estimate and source' },
  { name: '/settings', description: 'Theme, side panel, budgets, context, skills…', hint: 'Ctrl+O' },
  { name: '/theme', args: '<name>', description: 'Switch the color theme', needsArgs: true },
  { name: '/mcp', description: 'Connect MCP servers (external tools for the agent)' },
  { name: '/think', args: '[off|low|medium|high]', description: 'Reasoning level for the current model (if it supports it)' },
  { name: '/cost', description: 'What this session cost — and what VARA saved you' },
  { name: '/attach', args: '<file>', description: 'Attach an image, PDF or text file to your next message (or type @path)', needsArgs: true },
  { name: '/preview', args: '[start <command> | stop | logs]', description: 'Run the dev server and print its live URL (the agent can start it too)' },
  { name: '/export', args: '[file]', description: 'Save this conversation as a markdown file' },
  { name: '/skills', args: '[new <name>]', description: 'List skills, or create one' },
  { name: '/skill', args: '<name> [about]', description: 'Make the agent apply a skill now', needsArgs: true },
  { name: '/status', description: 'Budget and progress' },
  { name: '/evidence', description: 'Recorded evidence' },
  { name: '/last', description: 'Full output of the last tool call' },
  { name: '/pause', description: 'Pause the running agent (state is saved)' },
  { name: '/enable', args: '<skill|server>', description: 'Turn a skill or MCP server on for this session only', needsArgs: true },
  { name: '/disable', args: '<skill|server>', description: 'Turn a skill or MCP server off for this session only', needsArgs: true },
  { name: '/approve', args: '[id]', description: 'Allow the change the agent asked to make to itself' },
  { name: '/deny', args: '[id]', description: 'Decline the change the agent asked for' },
  { name: '/stop', description: 'Stop the session permanently' },
  { name: '/quit', description: 'Save the session and exit', hint: 'Ctrl+C' },
  { name: '/help', description: 'Commands and keyboard shortcuts' },
]

export const KEYS_HELP = `Keyboard:
  Ctrl+N          new session (opens the start screen as a new tab)
  Ctrl+K          command palette (type to filter)
  Ctrl+O          settings
  Ctrl+J          insert a newline in the message
  Tab             toggle PLAN / BUILD
  Alt+← / Alt+→   switch between open session tabs
  Ctrl+W          close the current tab (the session stays on disk)
  Ctrl+B          toggle the side panel
  Wheel / ↑ ↓     scroll the transcript (PgUp/PgDn: faster)
  Ctrl+G          latest entry (start screen: auto → task → goal)
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
