import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { skillsDir } from '../config/paths.js'

/**
 * Skills: reusable playbooks the agent loads on demand.
 *
 * A skill is a markdown file with a small front matter:
 *
 *   ---
 *   name: release-notes
 *   description: Write release notes from the git log (use when asked for a changelog)
 *   ---
 *   # steps…
 *
 * Only `name` + `description` go into the system prompt (cheap); the body is
 * loaded through the `skill` tool when the agent decides it applies. Locations,
 * later ones win on a name clash: built-in → ~/.vara/skills → <project>/.vara/skills.
 */

export interface Skill {
  name: string
  description: string
  body: string
  source: 'builtin' | 'user' | 'project'
  /** File the skill came from (absent for built-ins). */
  path?: string
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/

export function validSkillName(name: string): boolean {
  return NAME_RE.test(name)
}

/** Parse `---` front matter (flat `key: value` lines). Tolerates a missing header. */
export function parseSkill(text: string, fallbackName: string): { name: string; description: string; body: string } {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const meta: Record<string, string> = {}
  let body = src
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src)
  if (m) {
    for (const line of m[1]!.split('\n')) {
      const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line.trim())
      if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.replace(/^["']|["']$/g, '').trim()
    }
    body = src.slice(m[0].length)
  }
  const name = (meta['name'] || fallbackName).toLowerCase()
  const firstLine = body.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.trim() ?? ''
  return { name, description: meta['description'] || firstLine.slice(0, 160), body: body.trim() }
}

async function readSkillsFrom(dir: string, source: Skill['source']): Promise<Skill[]> {
  if (!existsSync(dir)) return []
  const out: Skill[] = []
  let entries: string[] = []
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    try {
      const st = await stat(full)
      const file = st.isDirectory() ? join(full, 'SKILL.md') : entry.toLowerCase().endsWith('.md') ? full : null
      if (!file || !existsSync(file)) continue
      const fallback = st.isDirectory() ? entry : basename(entry, '.md')
      const parsed = parseSkill(await readFile(file, 'utf8'), fallback)
      if (!validSkillName(parsed.name) || !parsed.body) continue
      out.push({ ...parsed, source, path: file })
    } catch {
      /* one unreadable skill must never hide the others */
    }
  }
  return out
}

export function projectSkillsDir(cwd: string): string {
  return join(cwd, '.vara', 'skills')
}

/** Every skill visible from `cwd`, minus the disabled names. Sorted by name. */
export async function discoverSkills(cwd: string, disabled: string[] = []): Promise<Skill[]> {
  const { BUILTIN_SKILLS } = await import('./builtin-skills.js')
  const byName = new Map<string, Skill>()
  for (const s of BUILTIN_SKILLS) byName.set(s.name, s)
  for (const s of await readSkillsFrom(skillsDir, 'user')) byName.set(s.name, s)
  for (const s of await readSkillsFrom(projectSkillsDir(cwd), 'project')) byName.set(s.name, s)
  const off = new Set(disabled)
  return [...byName.values()].filter((s) => !off.has(s.name)).sort((a, b) => a.name.localeCompare(b.name))
}

/** Same as discoverSkills but keeps disabled ones, flagged — for the settings screen. */
export async function discoverAllSkills(cwd: string, disabled: string[]): Promise<Array<Skill & { enabled: boolean }>> {
  const all = await discoverSkills(cwd, [])
  const off = new Set(disabled)
  return all.map((s) => ({ ...s, enabled: !off.has(s.name) }))
}

/** Create a skill template and return its path. */
export async function scaffoldSkill(name: string, scope: 'user' | 'project', cwd: string): Promise<string> {
  if (!validSkillName(name)) throw new Error('Skill name: lowercase letters, digits, "-" or "_" (max 40).')
  const dir = join(scope === 'project' ? projectSkillsDir(cwd) : skillsDir, name)
  const file = join(dir, 'SKILL.md')
  if (existsSync(file)) throw new Error(`Skill "${name}" already exists: ${file}`)
  await mkdir(dir, { recursive: true })
  await writeFile(
    file,
    `---\nname: ${name}\ndescription: One line — WHEN should the agent use this skill?\n---\n# ${name}\n\nStep-by-step instructions the agent follows when this skill applies.\n\n1. …\n2. …\n`,
    'utf8',
  )
  return file
}

/** The compact index that goes into the system prompt. */
export function skillIndex(skills: Skill[]): string {
  if (!skills.length) return ''
  return skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')
}
