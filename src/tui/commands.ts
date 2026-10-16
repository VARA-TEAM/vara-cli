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
  { name: '/agents', args: '[cancel <id|all> | report | list]', description: 'Sub-agents of this session: roles, status, cost, reports; cancel one or all' },
  { name: '/connectors', args: '[add <id>]', description: 'Ready-made connectors (GitHub, Notion, Sentry…); add one with its token' },
  { name: '/think', args: '[off|low|medium|high]', description: 'Reasoning level for the current model (if it supports it)' },
  { name: '/undo', args: '[n]', description: 'Put back the last n file changes the agent made (default 1); /checkpoints lists them' },
  { name: '/checkpoints', description: 'The file changes the agent made in this session that /undo can put back' },
  { name: '/compact', description: 'Fold the older conversation into a summary now (optional: what to keep: /compact keep the DB schema decisions)' },
  { name: '/autocompact', description: 'Turn automatic compaction on or off, or set the share of the window that triggers it: /autocompact on | off | 70' },
  { name: '/cost', description: 'What this session cost — and what VARA saved you' },
  { name: '/limit', args: '[5000000 tokens per 5h | $20 per month | percent 37 | eco on|off | off]', description: 'Your limit: see how much is used and how long it lasts, or set it' },
  { name: '/savings', description: 'What VARA saved: this session, 7 days, all time (with the method)' },
  { name: '/route', args: '[floor <tier> | <tier> <model> [provider] | on|off]', description: 'Which model handles which turn, and the quality floor' },
  { name: '/attach', args: '<file>', description: 'Attach an image, PDF or text file to your next message (or type @path)', needsArgs: true },
  { name: '/preview', args: '[start <command> | stop | logs]', description: 'Run the dev server and print its live URL (the agent can start it too)' },
  { name: '/export', args: '[file]', description: 'Save this conversation as a markdown file' },
  { name: '/skills', args: '[new <name> | proposals | show|approve|reject <id>]', description: 'List skills, create one, or review the ones the agent proposed' },
  { name: '/memory', args: '[add|edit|remove|on|off]', description: 'Notes that persist between sessions: see, add, edit, remove (project, or user)' },
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
