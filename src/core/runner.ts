import type { EngineEvent, Session } from './types.js'
import { Engine } from './engine.js'
import type { Provider } from '../llm/provider.js'
import { loadSession, saveSession } from './store.js'

/**
 * SessionRunner owns the engine lifecycle across pauses and resumes.
 * Each resume creates a fresh Engine over the same persisted Session, so a
 * restarted process picks up exactly where the state snapshot left off.
 */
export class SessionRunner {
  private engine: Engine | null = null
  private running = false
  private pendingFollowUps: string[] = []

  constructor(
    readonly session: Session,
    private readonly provider: Provider,
    private readonly model: string | undefined,
    private readonly onEvent: (event: EngineEvent) => void,
  ) {}

  get isRunning(): boolean {
    return this.running
  }

  /** Queue text to be delivered at the next safe point (or on next start). */
  send(text: string): void {
    if (this.running && this.engine) {
      this.engine.queueFollowUp(text)
      return
    }
    this.pendingFollowUps.push(text)
  }

  pause(): void {
    if (this.engine && this.running) {
      this.engine.stop()
      this.session.state = 'paused'
      this.session.stateReason = 'Paused by the user.'
    }
  }

  async start(): Promise<Session> {
    if (this.running) return this.session
    this.running = true

    this.engine = new Engine({
      session: this.session,
      provider: this.provider,
      model: this.model,
      onEvent: this.onEvent,
    })
    for (const text of this.pendingFollowUps) this.engine.queueFollowUp(text)
    this.pendingFollowUps = []

    try {
      await this.engine.run()
    } finally {
      this.running = false
      this.engine = null
      await saveSession(this.session)
    }
    return this.session
  }

  /** Reloads the session from disk (e.g. after an external edit). */
  static async reload(id: string): Promise<Session | null> {
    return loadSession(id)
  }
}
