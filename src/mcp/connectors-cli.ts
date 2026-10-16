import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { loadConfig, persistConfig } from '../config/config.js'
import { listSecrets, setSecret } from '../security/vault.js'
import { registerSecret } from '../security/redact.js'
import { CONNECTORS, connectorServer, findConnector } from './connectors.js'
import { beginLogin, oauthLogout, oauthStatus } from './oauth.js'

/** Open an address in the default browser; false when that is not possible here (headless, SSH). */
function openBrowser(url: string): boolean {
  if (process.env['SSH_CONNECTION'] || process.env['SSH_TTY']) return false
  if (process.platform === 'linux' && !process.env['DISPLAY'] && !process.env['WAYLAND_DISPLAY']) return false
  try {
    const [cmd, args]: [string, string[]] =
      process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

/** `vara connectors login <id> [--port N] [--no-open]` — browser sign-in; the tokens go to the vault only. */
async function loginCommand(id: string, rest: string[]): Promise<void> {
  const c = findConnector(id)
  if (!c?.oauth) throw new Error(`"${id}" has no browser sign-in. Sign-in connectors: ${CONNECTORS.filter((x) => x.oauth).map((x) => x.id).join(', ')}`)
  const portArg = rest.indexOf('--port')
  const port = portArg >= 0 ? Number(rest[portArg + 1]) : undefined
  if (port !== undefined && !(Number.isInteger(port) && port >= 1024 && port <= 65535)) throw new Error('--port must be a number between 1024 and 65535')
  const handle = await beginLogin({ id: c.id, resourceUrl: c.config.url!, ...(c.oauth.scope ? { scope: c.oauth.scope } : {}), ...(port ? { port } : {}), clientName: 'VARA' })
  console.log(`Sign in to ${c.name}:\n\n  ${handle.authUrl}\n`)
  const opened = !rest.includes('--no-open') && openBrowser(handle.authUrl)
  console.log(opened ? 'Opened in your browser. Approve access there.' : 'Open that address in a browser and approve access.')
  console.log(`If the browser is on another computer (a server over SSH) the page it lands on will not load — that is expected. Copy the whole address from its address bar (it starts with ${handle.redirectUri}) and paste it here.\n`)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  rl.setPrompt('Paste the address here (or just wait for the browser): ')
  rl.on('line', (line) => {
    const t = line.trim()
    if (t) handle.submitPasted(t).catch((err: Error) => console.log(`  ${err.message}`))
    rl.prompt()
  })
  rl.prompt()
  try {
    await handle.done
  } finally {
    rl.close()
    handle.cancel()
  }
  const config = await loadConfig()
  if (!config.mcp.servers[c.id]) await persistConfig({ ...config, mcp: { ...config.mcp, servers: { ...config.mcp.servers, [c.id]: connectorServer(c) as never } } })
  console.log(`\nSigned in. ${c.name} connects the next time VARA starts (or reopen /mcp in a running one). The tokens are in the encrypted vault only.`)
}

/** Ask for a secret without echoing it. */
export function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const w = rl as unknown as { _writeToOutput: (s: string) => void }
    let muted = false
    const original = w._writeToOutput.bind(rl)
    w._writeToOutput = (s: string) => original(muted ? '' : s)
    rl.question(question, (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer.trim())
    })
    muted = true
  })
}

/** `vara connectors [list | add <id> | remove <id>]` — the same catalogue as the web Settings → Connectors tab. */
export async function connectorsCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list'
  const config = await loadConfig()
  const have = new Set((await listSecrets()).map((s) => s.name))
  if (sub === 'list') {
    for (const c of CONNECTORS) {
      const added = config.mcp.servers[c.id] ? (config.mcp.servers[c.id]!.enabled === false ? 'off ' : 'on  ') : '    '
      const need = c.secrets.filter((s) => !have.has(s.name)).map((s) => s.name)
      const signed = c.oauth ? ((await oauthStatus(c.id)).signedIn ? '  [signed in]' : '  [sign-in needed]') : ''
      console.log(`${added} ${c.id.padEnd(20)} ${c.category.padEnd(10)} ${c.description}${signed}`)
      if (!config.mcp.servers[c.id] && need.length) console.log(`${' '.repeat(36)}needs: ${need.join(', ')}`)
    }
    console.log('\nAdd one: vara connectors add <id>   ·   remove: vara connectors remove <id>')
    console.log('Browser sign-in (the connectors marked [sign-in needed]): vara connectors login <id>   ·   sign out: vara connectors logout <id>   (docs/OAUTH.md)')
    return
  }
  const id = args[1]
  if (sub === 'login' && id) return loginCommand(id, args.slice(2))
  const c = id ? findConnector(id) : undefined
  if (!c) throw new Error(`Usage: vara connectors list | add <id> | remove <id> | login <id> | logout <id>${id ? `\nUnknown connector "${id}". See: vara connectors list` : ''}`)
  if (sub === 'logout') {
    if (!c.oauth) throw new Error(`${c.name} does not use a browser sign-in.`)
    const out = await oauthLogout(c.id)
    console.log(out.was ? `Signed out of ${c.name}: the stored tokens were deleted${out.revoked ? ' and the service revoked them.' : '. The service has no revocation endpoint or did not answer — revoke VARA in the service own settings to be sure.'}` : `${c.name} was not signed in.`)
    return
  }
  if (sub === 'add') {
    if (c.oauth) throw new Error(`${c.name} signs in with your browser: vara connectors login ${c.id}`)
    if (config.mcp.servers[c.id]) throw new Error(`${c.name} is already connected.`)
    for (const s of c.secrets) {
      if (have.has(s.name)) continue
      console.log(`${s.label}\n  ${s.help}`)
      const v = await askHidden(`${s.name}: `)
      if (!v) throw new Error('No value given — nothing was added.')
      await setSecret(s.name, v)
      registerSecret(v, s.name)
    }
    await persistConfig({ ...config, mcp: { ...config.mcp, servers: { ...config.mcp.servers, [c.id]: connectorServer(c) as never } } })
    console.log(`${c.name} added. It connects the next time VARA starts (or reopen /mcp in a running one).`)
    return
  }
  if (sub === 'remove') {
    if (!config.mcp.servers[c.id]) throw new Error(`${c.name} is not connected.`)
    const { [c.id]: _gone, ...rest } = config.mcp.servers
    await persistConfig({ ...config, mcp: { ...config.mcp, servers: rest } })
    if (c.oauth) {
      await oauthLogout(c.id)
      console.log(`${c.name} removed and signed out (the stored tokens were deleted).`)
      return
    }
    console.log(`${c.name} removed. Its secrets stay in the vault (vara secret delete <NAME> to remove them).`)
    return
  }
  throw new Error('Usage: vara connectors list | add <id> | remove <id> | login <id> | logout <id>')
}
