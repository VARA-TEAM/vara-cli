import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fitSize, needsPaste, pngSize, type Shot } from './policy.js'

const run = promisify(execFile)

/** What the OS-specific layers must offer. Coordinates are REAL screen pixels. */
export interface DesktopDriver {
  readonly name: string
  screenshot(): Promise<{ png: Buffer; shot: Shot }>
  click(x: number, y: number, button?: 'left' | 'right', double?: boolean): Promise<void>
  move(x: number, y: number): Promise<void>
  drag(x1: number, y1: number, x2: number, y2: number): Promise<void>
  type(text: string): Promise<void>
  key(combo: string): Promise<void>
  scroll(dy: number): Promise<void>
  activeWindowTitle(): Promise<string>
}

/* ------------------------------ Windows (PowerShell + user32) ------------------------------ */

const PRELUDE = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(int f, int dx, int dy, int d, int e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@
[void][W]::SetProcessDPIAware()
$a = $env:VARA_DESKTOP_ARGS | ConvertFrom-Json
function Click($x, $y, $right, $double) {
  [void][W]::SetCursorPos([int]$x, [int]$y); Start-Sleep -Milliseconds 40
  $d = if ($right) { 0x8 } else { 0x2 }; $u = if ($right) { 0x10 } else { 0x4 }
  $n = if ($double) { 2 } else { 1 }
  for ($i = 0; $i -lt $n; $i++) { [W]::mouse_event($d, 0, 0, 0, 0); [W]::mouse_event($u, 0, 0, 0, 0); Start-Sleep -Milliseconds 60 }
}
function Esc-Keys($t) { ($t.ToCharArray() | ForEach-Object { if ('+^%~(){}[]'.Contains([string]$_)) { '{' + $_ + '}' } else { [string]$_ } }) -join '' }
`

const ACTIONS: Record<string, string> = {
  screenshot: `
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); $g.Dispose()
$out = New-Object System.Drawing.Bitmap ([int]$a.width), ([int]$a.height)
$g2 = [System.Drawing.Graphics]::FromImage($out); $g2.InterpolationMode = 'HighQualityBicubic'; $g2.DrawImage($bmp, 0, 0, [int]$a.width, [int]$a.height); $g2.Dispose()
$ms = New-Object System.IO.MemoryStream; $out.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
@{ w = $b.Width; h = $b.Height; b64 = [Convert]::ToBase64String($ms.ToArray()) } | ConvertTo-Json -Compress`,
  size: `$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; @{ w = $b.Width; h = $b.Height } | ConvertTo-Json -Compress`,
  click: `Click $a.x $a.y ($a.button -eq 'right') $a.double`,
  move: `[void][W]::SetCursorPos([int]$a.x, [int]$a.y)`,
  drag: `[void][W]::SetCursorPos([int]$a.x1, [int]$a.y1); Start-Sleep -Milliseconds 60; [W]::mouse_event(0x2,0,0,0,0)
for ($i = 1; $i -le 12; $i++) { [void][W]::SetCursorPos([int]($a.x1 + ($a.x2 - $a.x1) * $i / 12), [int]($a.y1 + ($a.y2 - $a.y1) * $i / 12)); Start-Sleep -Milliseconds 15 }
[W]::mouse_event(0x4,0,0,0,0)`,
  type: `if ($a.paste) { Set-Clipboard -Value $a.text; [System.Windows.Forms.SendKeys]::SendWait('^v') } else { [System.Windows.Forms.SendKeys]::SendWait((Esc-Keys ($a.text -replace "\`r?\`n", '{ENTER}'))) }`,
  key: `[System.Windows.Forms.SendKeys]::SendWait($a.combo)`,
  scroll: `[W]::mouse_event(0x800, 0, 0, [int](-120 * $a.dy), 0)`,
  title: `$s = New-Object System.Text.StringBuilder 512; [void][W]::GetWindowText([W]::GetForegroundWindow(), $s, 512); $s.ToString()`,
}

/** Combos in the notation the model uses → SendKeys notation. */
export function toSendKeys(combo: string): string {
  const parts = combo.toLowerCase().replace(/\s+/g, '').split('+')
  const key = parts.pop() ?? ''
  const mods = parts.map((m) => ({ ctrl: '^', control: '^', alt: '%', shift: '+' })[m as 'ctrl'] ?? '').join('')
  const named: Record<string, string> = { enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', escape: '{ESC}', esc: '{ESC}', backspace: '{BACKSPACE}', delete: '{DELETE}', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}', home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}', space: ' ' }
  const k = named[key] ?? (/^f([1-9]|1[0-2])$/.test(key) ? `{${key.toUpperCase()}}` : key.length === 1 ? (('+^%~(){}[]'.includes(key) ? `{${key}}` : key)) : '')
  if (!k) throw new Error(`unknown key "${combo}"`)
  return mods + k
}

export function windowsDriver(maxWidth = 1280): DesktopDriver {
  const ps = async (action: keyof typeof ACTIONS, args: Record<string, unknown> = {}): Promise<string> => {
    const script = `${PRELUDE}\n${ACTIONS[action]}`
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      env: { ...process.env, VARA_DESKTOP_ARGS: JSON.stringify(args) },
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      timeout: 30_000,
    })
    return stdout.trim()
  }
  return {
    name: 'windows',
    async screenshot() {
      const size = JSON.parse(await ps('size')) as { w: number; h: number }
      const fit = fitSize(size.w, size.h, maxWidth)
      const r = JSON.parse(await ps('screenshot', { width: fit.width, height: fit.height })) as { b64: string }
      return { png: Buffer.from(r.b64, 'base64'), shot: { width: fit.width, height: fit.height, scale: fit.scale } }
    },
    click: async (x, y, button = 'left', double = false) => void (await ps('click', { x, y, button, double })),
    move: async (x, y) => void (await ps('move', { x, y })),
    drag: async (x1, y1, x2, y2) => void (await ps('drag', { x1, y1, x2, y2 })),
    type: async (text) => void (await ps('type', { text, paste: needsPaste(text) })),
    key: async (combo) => void (await ps('key', { combo: toSendKeys(combo) })),
    scroll: async (dy) => void (await ps('scroll', { dy })),
    activeWindowTitle: async () => ps('title'),
  }
}

/* ------------------------------ macOS and Linux (best effort, see docs) ------------------------------ */

async function has(cmd: string): Promise<boolean> {
  try {
    await run(process.platform === 'win32' ? 'where' : 'which', [cmd])
    return true
  } catch {
    return false
  }
}

async function tmpFile(ext: string): Promise<{ file: string; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'vara-desk-'))
  return { file: join(dir, `s.${ext}`), done: () => rm(dir, { recursive: true, force: true }) }
}

export function macDriver(): DesktopDriver {
  const osa = async (script: string): Promise<string> => (await run('osascript', ['-e', script])).stdout.trim()
  const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return {
    name: 'macos',
    async screenshot() {
      const t = await tmpFile('png')
      try {
        await run('screencapture', ['-x', '-t', 'png', t.file])
        const png = await readFile(t.file)
        const size = pngSize(png) ?? { width: 1280, height: 800 }
        // Retina screenshots are 2x the click space: report that as the scale so coordinates map back.
        return { png, shot: { width: size.width, height: size.height, scale: 1 } }
      } finally {
        await t.done()
      }
    },
    click: async (x, y, _b, double) => {
      for (let i = 0; i < (double ? 2 : 1); i++) await osa(`tell application "System Events" to click at {${x}, ${y}}`)
    },
    move: async () => {
      throw new Error('moving the pointer alone is not supported on macOS without extra tools; click instead')
    },
    drag: async () => {
      throw new Error('drag is not supported on macOS without extra tools')
    },
    type: async (text) => void (await osa(`tell application "System Events" to keystroke "${esc(text)}"`)),
    key: async (combo) => {
      const parts = combo.toLowerCase().split('+')
      const key = parts.pop() ?? ''
      const mods = parts.map((m) => ({ ctrl: 'control down', control: 'control down', alt: 'option down', shift: 'shift down', meta: 'command down', cmd: 'command down' })[m as 'ctrl']).filter(Boolean)
      const codes: Record<string, number> = { enter: 36, return: 36, tab: 48, escape: 53, esc: 53, backspace: 51, delete: 117, up: 126, down: 125, left: 123, right: 124, space: 49 }
      const using = mods.length ? ` using {${mods.join(', ')}}` : ''
      await osa(`tell application "System Events" to ${codes[key] !== undefined ? `key code ${codes[key]}` : `keystroke "${esc(key)}"`}${using}`)
    },
    scroll: async () => {
      throw new Error('scroll is not supported on macOS without extra tools')
    },
    activeWindowTitle: async () => osa('tell application "System Events" to get name of first application process whose frontmost is true').catch(() => ''),
  }
}

export function linuxDriver(): DesktopDriver {
  const xd = async (...args: string[]): Promise<string> => {
    if (!(await has('xdotool'))) throw new Error('desktop control on Linux needs xdotool (X11). Install it, or use the browser tool.')
    return (await run('xdotool', args)).stdout.trim()
  }
  return {
    name: 'linux',
    async screenshot() {
      const t = await tmpFile('png')
      try {
        if (await has('scrot')) await run('scrot', ['-o', t.file])
        else if (await has('import')) await run('import', ['-window', 'root', t.file])
        else if (await has('gnome-screenshot')) await run('gnome-screenshot', ['-f', t.file])
        else throw new Error('no screenshot tool found: install scrot, ImageMagick (import) or gnome-screenshot')
        const png = await readFile(t.file)
        const size = pngSize(png) ?? { width: 1280, height: 800 }
        return { png, shot: { width: size.width, height: size.height, scale: 1 } }
      } finally {
        await t.done()
      }
    },
    click: async (x, y, button = 'left', double = false) => {
      await xd('mousemove', String(x), String(y))
      await xd('click', ...(double ? ['--repeat', '2'] : []), button === 'right' ? '3' : '1')
    },
    move: async (x, y) => void (await xd('mousemove', String(x), String(y))),
    drag: async (x1, y1, x2, y2) => {
      await xd('mousemove', String(x1), String(y1))
      await xd('mousedown', '1')
      await xd('mousemove', String(x2), String(y2))
      await xd('mouseup', '1')
    },
    type: async (text) => void (await xd('type', '--delay', '12', '--', text)),
    key: async (combo) => void (await xd('key', combo.replace(/\bmeta\b/gi, 'super').replace(/\bctrl\b/gi, 'ctrl'))),
    scroll: async (dy) => void (await xd('click', ...(dy > 0 ? ['--repeat', String(Math.abs(Math.round(dy))), '5'] : ['--repeat', String(Math.abs(Math.round(dy))), '4']))),
    activeWindowTitle: async () => xd('getactivewindow', 'getwindowname').catch(() => ''),
  }
}

export function platformDriver(): DesktopDriver {
  if (process.platform === 'win32') return windowsDriver()
  if (process.platform === 'darwin') return macDriver()
  return linuxDriver()
}
