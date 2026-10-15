import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { VARA_HOME } from '../config/paths.js'

/** Chrome, Edge or Chromium already installed on this machine (VARA ships no browser). */
export function findBrowser(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): string | null {
  const given = env['VARA_BROWSER']
  if (given && exists(given)) return given
  const c: string[] = []
  if (platform === 'win32') {
    for (const base of [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']]) {
      if (!base) continue
      c.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(base, 'Chromium', 'Application', 'chrome.exe'), join(base, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'))
    }
  } else if (platform === 'darwin') {
    c.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser')
  } else {
    for (const dir of (env['PATH'] ?? '').split(':')) for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) if (dir) c.push(join(dir, n))
  }
  return c.find((p) => exists(p)) ?? null
}

export interface Launched {
  wsUrl: string
  /** Synchronous kill, for the process 'exit' hook (no profile clean-up). */
  kill(): void
  close(): Promise<void>
}

/** A fresh, isolated profile per launch: nothing the user is signed in to is reachable. */
export async function launchBrowser(opts: { executable: string; headless?: boolean; profileRoot?: string }): Promise<Launched> {
  const root = opts.profileRoot ?? join(VARA_HOME, 'browser')
  const profile = join(root, `profile-${process.pid}-${Date.now().toString(36)}`)
  await mkdir(profile, { recursive: true })
  const args = [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--password-store=basic',
    '--window-size=1280,860',
    ...(opts.headless === false ? [] : ['--headless=new']),
    'about:blank',
  ]
  const child: ChildProcess = spawn(opts.executable, args, { stdio: 'ignore', windowsHide: true })
  const port = join(profile, 'DevToolsActivePort')
  const started = Date.now()
  let wsUrl = ''
  while (Date.now() - started < 20_000) {
    if (child.exitCode !== null) throw new Error('the browser exited while starting')
    if (existsSync(port)) {
      const [p, path] = (await readFile(port, 'utf8')).split(/\r?\n/)
      if (p && path) {
        wsUrl = `ws://127.0.0.1:${p}${path}`
        break
      }
    }
    await new Promise((r) => setTimeout(r, 120))
  }
  if (!wsUrl) {
    child.kill()
    throw new Error('the browser did not start in time')
  }
  return {
    wsUrl,
    kill: () => {
      try {
        child.kill()
      } catch {
        /* gone */
      }
    },
    close: async () => {
      try {
        child.kill()
      } catch {
        /* gone */
      }
      await new Promise((r) => setTimeout(r, 300))
      await rm(profile, { recursive: true, force: true }).catch(() => {})
    },
  }
}
