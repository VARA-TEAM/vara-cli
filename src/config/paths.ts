import { homedir } from 'node:os'
import { join } from 'node:path'

/** Root directory for all VARA state. Override with VARA_HOME. */
export const VARA_HOME: string = process.env['VARA_HOME'] ?? join(homedir(), '.vara')

export const sessionsDir: string = join(VARA_HOME, 'sessions')
export const vaultDir: string = join(VARA_HOME, 'vault')
/** Host (sharing) state: invites, guests, last server address. */
export const hostDir: string = join(VARA_HOME, 'host')
export const configFile: string = join(VARA_HOME, 'config.json')
/** User-level skills: ~/.vara/skills/<name>/SKILL.md (projects add <cwd>/.vara/skills). */
export const skillsDir: string = join(VARA_HOME, 'skills')

export function sessionDir(sessionId: string): string {
  return join(sessionsDir, sessionId)
}

export function sessionEventsFile(sessionId: string): string {
  return join(sessionsDir, sessionId, 'events.jsonl')
}

export function sessionStateFile(sessionId: string): string {
  return join(sessionsDir, sessionId, 'state.json')
}
