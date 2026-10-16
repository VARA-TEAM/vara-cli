import type { EngineEvent, Session } from './types.js'
import { Engine, type EngineOptions } from './engine.js'
import type { Provider } from '../llm/provider.js'
import { loadSession, saveSession } from './store.js'
import type { ContextSettings } from './context.js'
import { killDesktop } from '../tools/desktop-tool.js'
import { undo as undoChanges, type UndoResult } from '../tools/file-guard.js'

/**
 * SessionRunner owns the engine lifecycle across pauses and resumes.
 * Each resume creates a fresh Engine over the same persisted Session, so a
 * restarted process picks up exactly where the state snapshot left off.
 */
export class SessionRunner {
  private engine: Engine | null = null
  private running = false
  private pendingFollowUps: string[] = []
  /** pause() was pressed and the run has not finished unwinding yet. */
  private stopping = false
  /** A message arrived while stopping: the session must run again instead of silently dropping it. */
  private restart = false

  constructor(
    readonly session: Session,
    private readonly provider: Provider,
    private readonly model: string | undefined,
    private readonly onEvent: (event: EngineEvent) => void,
    private readonly contextSettings?: () => ContextSettings,
    private readonly extras: Pick<EngineOptions, 'loadSkills' | 'budgetFor' | 'routeModel' | 'thinkingLevel' | 'modePolicy' | 'swarm' | 'vision' | 'admin' | 'interactive' | 'extraTools' | 'memoryBlock' | 'mcpSummary' | 'router' | 'providerFor' | 'meter' | 'limits' | 'costSettings'> = {},
  ) {}

  get isRunning(): boolean {
    return this.running
  }

  /** Queue text to be delivered at the next safe point (or on next start). */
  send(text: string): void {
    if (this.running && this.engine && !this.stopping) {
      this.engine.queueFollowUp(text)
      return
    }
    this.pendingFollowUps.push(text)
    if (this.running) this.restart = true
  }

  /** Answer an approval the agent is waiting on. */
  resolveApproval(id: string, approved: boolean, note?: string): boolean {
    return this.engine?.resolveApproval(id, approved, note) ?? false
  }

  /** Cancel one running sub-agent (by its task id) or, with no id, the whole swarm. False when none is running. */
  cancelAgents(id?: string): boolean {
    return this.engine?.cancelSubagents(id) ?? false
  }

  pause(): void {
    // The desktop kill switch: whatever the agent was about to do on the screen is cancelled at once.
    killDesktop(this.session.id)
    if (this.engine && this.running) {
      this.stopping = true
      this.engine.stop()
      this.session.state = 'paused'
      this.session.stateReason = 'Paused by the user.'
    }
  }

  /** `/undo [n]`: put back the last n file changes the agent made (newest first). Refused while a run is going. */
  async undo(count = 1): Promise<UndoResult | 'busy'> {
    if (this.running) return 'busy'
    return undoChanges(this.session.id, count)
  }

  /** `/compact [focus]`: fold the older conversation into a summary now. Refused while a run is going. */
  async compact(focus?: string): Promise<{ folded: number; savedTokens: number } | null | 'busy'> {
    if (this.running) return 'busy'
    const engine = new Engine({ session: this.session, provider: this.provider, model: this.model, contextSettings: this.contextSettings, ...this.extras, onEvent: this.onEvent })
    const result = await engine.compactNow(focus)
    await saveSession(this.session)
    if (result) this.onEvent({ type: 'compacted', folded: result.folded, savedTokens: result.savedTokens, auto: false })
    return result
  }

  async start(): Promise<Session> {
    if (this.running) return this.session
    this.running = true
    try {
      do {
        this.restart = false
        this.stopping = false
        this.engine = new Engine({
          session: this.session,
          provider: this.provider,
          model: this.model,
          contextSettings: this.contextSettings,
          ...this.extras,
          onEvent: this.onEvent,
        })
        for (const text of this.pendingFollowUps) this.engine.queueFollowUp(text)
        this.pendingFollowUps = []
        try {
          await this.engine.run()
        } finally {
          // What the stopped run never got to show the model waits for the next start.
          this.pendingFollowUps.unshift(...this.engine.takeUninjected())
          this.engine = null
          await saveSession(this.session)
        }
        // A message sent while the run was stopping starts the session again (it used to be dropped).
      } while (this.restart)
    } finally {
      this.running = false
      this.stopping = false
    }
    return this.session
  }

  /** Reloads the session from disk (e.g. after an external edit). */
  static async reload(id: string): Promise<Session | null> {
    return loadSession(id)
  }
}
