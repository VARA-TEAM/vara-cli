import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import type { EngineEvent, Mode, Session, SessionKind, SessionState } from '../core/types.js'
import type { Provider } from '../llm/provider.js'
import type { VaraConfig } from '../config/config.js'
import { SessionRunner } from '../core/runner.js'
import { loadSession, saveSession, listSessions } from '../core/store.js'
import { createSession, CreateSessionInput } from '../core/session.js'
import { contextStatus, estimateSessionTokens, formatTokens } from '../core/context.js'
import { formatUsd } from '../llm/cost.js'
import { configFile } from '../config/paths.js'
import { StateBadge, formatElapsed } from './format.js'
import { EntryView, firstLine, truncate, type Entry } from './entries.js'
import { appendEntry, replayTranscript, resumeBanner } from './history.js'
import { CommandPalette } from './palette.js'
import { SessionBrowser } from './sessions.js'
import { TabBar, nextTabId, type TabInfo } from './tabs.js'
import { Sidebar } from './sidebar.js'
import { WelcomeScreen } from './welcome.js'
import { helpText } from './commands.js'
import { resolveKey, type Overlay } from './keymap.js'

interface Props {
  /** null → welcome flow: the first message becomes a new session's objective. */
  session: Session | null
  provider: Provider
  config: VaraConfig
  autoStart: boolean
}

/**
 * Human-readable session cost. "unknown" is shown with a `+` marker when the
 * total is partial (some calls unpriced) — never rendered as $0.00, because
 * missing pricing is not free usage.
 */
function costLabel(usage: Session['usage']): string {
  if (usage.modelCalls === 0) return 'none yet'
  if (usage.costUsd === null) {
    return usage.unpricedCalls > 0 ? `unknown (${usage.unpricedCalls} unpriced)` : 'unknown'
  }
  const partial = usage.costPartial || usage.unpricedCalls > 0
  return `${formatUsd(usage.costUsd)}${partial ? '+' : ''}`
}

/** Rows of chrome (headers, input, footer, tabs) reserved above the transcript. */
const CHROME_ROWS = 13

export function App({ session, provider, config, autoStart }: Props): React.ReactElement {
  const { exit } = useApp()
  // --- session tabs: every open session stays in memory with its own view ---
  const [tabs, setTabs] = useState<Session[]>(session ? [session] : [])
  const [activeId, setActiveId] = useState(session?.id ?? '')
  // A resumed session must show its history from the first frame — replay the
  // persisted transcript instead of starting with an empty view.
  const [entries, setEntries] = useState<Entry[]>(() =>
    session && session.transcript.length ? [...replayTranscript(session), resumeBanner(session)] : [],
  )
  const [cwdHasSessions, setCwdHasSessions] = useState(false)
  const [stream, setStream] = useState('')
  const [state, setState] = useState<SessionState>(session?.state ?? 'idle')
  const [input, setInput] = useState('')
  const [tick, setTick] = useState(0)
  const [spinnerFrame, setSpinnerFrame] = useState(0)
  const [escArmed, setEscArmed] = useState(false)
  const [overlay, setOverlay] = useState<Overlay>(null)
  // --- scrollback: the transcript is a viewport, not an endless scroll ---
  const [scrollOffset, setScrollOffset] = useState(0)
  const [termRows, setTermRows] = useState(process.stdout.rows ?? 30)
  const [termColumns, setTermColumns] = useState(process.stdout.columns ?? 100)
  const [sidebarOn, setSidebarOn] = useState(true)
  // --- welcome-flow draft settings (no session yet) ---
  const [draftKind, setDraftKind] = useState<SessionKind>('task')
  const [draftMode, setDraftMode] = useState<Mode>('build')

  const runnerRef = useRef<SessionRunner | null>(null)
  const sessionRef = useRef<Session | null>(session)
  const tabsRef = useRef<Session[]>(tabs)
  const activeIdRef = useRef(activeId)
  const entriesCacheRef = useRef<Record<string, Entry[]>>({})
  const scrollOffsetRef = useRef(0)
  const streamingRef = useRef(false)
  const lastActivityRef = useRef<number>(Date.now())
  const activeToolRef = useRef<string | null>(null)
  const escTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastToolOutputRef = useRef<string>('')
  /** Mirror of `input` so async callbacks read the real current draft. */
  const inputRef = useRef('')
  /** Per-tab input drafts: switching tabs must not lose what was typed. */
  const inputCacheRef = useRef<Record<string, string>>({})
  /** Indirection to the fresh `runCommand` (defined below) — submit must never
   * call a stale copy that acts on the wrong session. */
  const runCommandRef = useRef<(value: string) => void>(() => {})
  /** Stale-closure shields for the input path. ink re-subscribes `useInput`
   * on every render, but a keystroke can arrive BEFORE the next subscription
   * flushes — the attached handler then belongs to the PREVIOUS render and
   * would read stale state (an Enter that reads an old `input` silently
   * submits an empty objective; an Esc that reads an old `overlay` misses).
   * Everything the handler reads therefore comes from these refs, written on
   * every render. */
  const overlayRef = useRef<Overlay>(null)
  const escArmedRef = useRef(false)
  const draftKindRef = useRef<SessionKind>('task')
  const draftModeRef = useRef<Mode>('build')

  tabsRef.current = tabs
  inputRef.current = input
  overlayRef.current = overlay
  escArmedRef.current = escArmed
  draftKindRef.current = draftKind
  draftModeRef.current = draftMode
  const active = tabs.find((t) => t.id === activeId) ?? null
  const activeRef = useRef<Session | null>(active)
  activeRef.current = active
  const model = active?.config.model ?? config.provider.model

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  /** Append with collapsing rules; cache per tab so switching is lossless. */
  const push = useCallback((entry: Entry) => {
    // While scrolled up, keep the viewed entries stable: grow the offset.
    if (scrollOffsetRef.current > 0) {
      scrollOffsetRef.current += 1
      setScrollOffset(scrollOffsetRef.current)
    }
    setEntries((prev) => {
      const next = appendEntry(prev, entry)
      const id = activeIdRef.current
      if (id) entriesCacheRef.current[id] = next
      return next
    })
  }, [])

  const handleEvent = useCallback(
    (event: EngineEvent) => {
      lastActivityRef.current = Date.now()
      // Any non-text event ends the streaming phase — flush buffered text so
      // it lands in the transcript instead of hanging in the live area forever.
      if (event.type !== 'text') flushStream(push, setStream)
      switch (event.type) {
        case 'state':
          setState(event.state)
          if (event.reason) push({ kind: 'note', text: event.reason, color: 'gray', group: 'state' })
          break
        case 'text':
          streamingRef.current = true
          streamBuffer += event.delta
          setStream(streamBuffer)
          break
        case 'tool_start':
          flushStream(push, setStream)
          activeToolRef.current = event.name
          push({ kind: 'tool', id: event.id, name: event.name, args: event.args })
          break
        case 'tool_end': {
          activeToolRef.current = null
          lastToolOutputRef.current = `[${event.name}] ${event.output}`
          setEntries((prev) => {
            const next = prev.map((e) =>
              e.kind === 'tool' && e.id === event.id ? { ...e, ok: event.ok, output: event.output } : e,
            )
            const id = activeIdRef.current
            if (id) entriesCacheRef.current[id] = next
            return next
          })
          break
        }
        case 'followup_applied':
          push({ kind: 'note', text: `follow-up applied at turn ${event.turn}`, color: 'cyan' })
          break
        case 'verification':
          push({
            kind: 'note',
            text: event.ok ? `verification passed: ${firstLine(event.detail)}` : `verification failed: ${firstLine(event.detail)}`,
            color: event.ok ? 'green' : 'red',
            group: 'verification',
          })
          break
        case 'completed':
          flushStream(push, setStream)
          break
        case 'session_summary': {
          const verifiedCount = event.requirements.filter((r) => r.verified).length
          const evidence = event.evidence
            .filter((e) => e.kind === 'command' || e.kind === 'verification' || e.kind === 'git_status')
            .slice(-6)
            .map((e) => `${e.ok ? '✓' : '✗'} ${e.output?.split('\n')[0] ?? e.kind}`)
          push({
            kind: 'summary',
            // The engine sets the state before emitting the summary — the
            // heading must mirror it, not claim completion blindly.
            state: sessionRef.current?.state ?? 'idle',
            text: event.summary,
            requirements: event.requirements,
            evidence,
            stats:
              `${verifiedCount}/${event.requirements.length} requirements verified · ` +
              `${event.turns} turns · ${event.toolCalls} tool calls · ${formatElapsed(event.elapsedMs / 1000)}` +
              (event.costUsd === null || event.costUsd === undefined
                ? ' · cost unknown'
                : ` · cost ${formatUsd(event.costUsd)}${event.costPartial ? '+' : ''}`),
          })
          break
        }
        case 'waiting':
          push({ kind: 'note', text: `waiting for you: ${event.reason}`, color: 'yellow', group: 'waiting' })
          break
        case 'budget_warning':
          push({ kind: 'note', text: event.message, color: 'yellow' })
          break
        case 'budget_exhausted':
          push({ kind: 'note', text: event.reason, color: 'yellow' })
          break
        case 'error':
          push({ kind: 'note', text: event.message, color: 'red' })
          break
        default:
          break
      }
      setTick((t) => t + 1)
    },
    [push],
  )

  /**
   * Attach a session as the active tab: pause any previous run, rebuild the
   * runner, and RESTORE its transcript — cached if this run already showed it,
   * otherwise replayed from the persisted session. A resumed session must
   * never show an empty history.
   */
  const attachSession = useCallback(
    (next: Session, note?: string) => {
      runnerRef.current?.pause()
      sessionRef.current = next
      setTabs((prev) => (prev.some((s) => s.id === next.id) ? prev.map((s) => (s.id === next.id ? next : s)) : [...prev, next]))
      setActiveId(next.id)
      activeIdRef.current = next.id
      setState(next.state)
      runnerRef.current = new SessionRunner(next, provider, next.config.model ?? config.provider.model, handleEvent)

      const cached = entriesCacheRef.current[next.id]
      if (cached) {
        setEntries(cached)
      } else {
        const replayed: Entry[] = next.transcript.length ? [...replayTranscript(next), resumeBanner(next)] : []
        if (note) replayed.push({ kind: 'note', text: note, color: 'cyan' })
        entriesCacheRef.current[next.id] = replayed
        setEntries(replayed)
      }
      streamBuffer = ''
      setStream('')
      scrollOffsetRef.current = 0
      setScrollOffset(0)
      refresh()
    },
    [provider, config.provider.model, handleEvent, refresh],
  )

  // The mount-time runner (a resumed session) lives in runnerRef alone — one
  // owner, no second ref that can drift out of sync with the tabs.
  if (!runnerRef.current && session) {
    runnerRef.current = new SessionRunner(session, provider, model, handleEvent)
  }

  const startRun = useCallback(() => {
    const r = runnerRef.current
    if (!r || r.isRunning) return
    void r.start().then(async () => {
      flushStream(push, setStream)
      setState(sessionRef.current?.state ?? 'idle')
      const cur = sessionRef.current
      if (cur && ['completed', 'failed'].includes(cur.state)) await saveSession(cur)
      setTick((t) => t + 1)
    })
  }, [push])

  useEffect(() => {
    if (autoStart && session && !['completed', 'failed', 'stopped'].includes(session.state)) {
      startRun()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Track terminal size for the viewport and the sidebar auto-hide.
  useEffect(() => {
    const onResize = () => {
      setTermRows(process.stdout.rows ?? 30)
      setTermColumns(process.stdout.columns ?? 100)
      setTick((t) => t + 1)
    }
    process.stdout.on('resize', onResize)
    return () => {
      process.stdout.off('resize', onResize)
    }
  }, [])

  // Seed the per-tab cache with the initial (replayed) view, and learn whether
  // this directory has saved sessions (welcome-screen hint).
  useEffect(() => {
    if (session) entriesCacheRef.current[session.id] = entries
    void listSessions().then((all) => {
      const here = process.cwd().replace(/[\\/]+$/, '').toLowerCase()
      setCwdHasSessions(all.some((s) => s.cwd.replace(/[\\/]+$/, '').toLowerCase() === here))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const switchTab = useCallback(
    (dir: -1 | 1) => {
      const infos: TabInfo[] = tabsRef.current.map((s) => ({ id: s.id, label: s.config.objective, state: s.state }))
      const nextId = nextTabId(infos, activeIdRef.current, dir)
      const next = tabsRef.current.find((s) => s.id === nextId)
      if (!next || next.id === activeIdRef.current) return
      // Each tab keeps its own draft: save the current input, restore the target's.
      inputCacheRef.current[activeIdRef.current] = inputRef.current
      void saveSession(sessionRef.current ?? next).then(() => {
        attachSession(next)
        setInput(inputCacheRef.current[next.id] ?? '')
      })
    },
    [attachSession],
  )

  /**
   * Create a session from an entered objective AND start it — the single path
   * behind the welcome screen, Ctrl+N and `/new <objective>`. Before this,
   * `/new <objective>` sent a follow-up to the CURRENT session and sessions
   * created with Ctrl+N never started at all (the objective just sat there).
   */
  const createSessionFlow = useCallback(
    (objective: string, opts: { kind: SessionKind; mode: Mode; cwd: string; model?: string }) => {
      try {
        const parsed = CreateSessionInput.parse({
          kind: opts.kind,
          mode: opts.mode,
          objective,
          cwd: opts.cwd,
          verifyCommand: config.defaultVerifyCommand || undefined,
          model: opts.model ?? config.provider.model,
        })
        const created = createSession(parsed, config)
        void saveSession(created)
        attachSession(created, `new session ${created.id} — ${truncate(created.config.objective, 80)}`)
        push({ kind: 'user', text: objective })
        startRun()
      } catch (err) {
        push({ kind: 'note', text: (err as Error).message, color: 'red' })
      }
    },
    [config, attachSession, push, startRun],
  )

  /** Open the focused "new objective" entry (Ctrl+N / /new). */
  const openNewSession = useCallback(
    (prefill = '') => {
      const current = activeRef.current
      if (!current) return
      // Keep the tab's draft for when we return, and start the entry clean.
      inputCacheRef.current[current.id] = inputRef.current
      setDraftMode(current.config.mode)
      setDraftKind(current.config.kind)
      setInput(prefill)
      inputRef.current = prefill
      setOverlay('new-session')
      push({
        kind: 'note',
        text: 'new session — type the objective and press Enter (Tab: PLAN/BUILD · Ctrl+G: task/goal · Esc cancels)',
        color: 'cyan',
      })
    },
    [push],
  )

  /** Load a session by id and attach it — works from the welcome screen too. */
  const switchToSession = useCallback(
    (id: string) => {
      void loadSession(id).then((next) => {
        if (!next) {
          push({ kind: 'note', text: `no session with id ${id}`, color: 'red' })
          return
        }
        const prev = sessionRef.current
        if (prev) void saveSession(prev).then(() => attachSession(next))
        else attachSession(next)
      })
    },
    [attachSession, push],
  )

  const submit = useCallback(
    (raw: string) => {
      const value = raw.trim()
      if (!value) return

      // Welcome flow: no session yet — the first message IS the objective.
      if (!activeRef.current) {
        // attachSession sets sessionRef synchronously; a second Enter in the
        // same frame (before the re-render) must not create a duplicate.
        if (sessionRef.current) return
        if (value.startsWith('/')) {
          // ONE dispatcher: runCommand's pre-session section handles /help,
          // /palette, /sessions, /new, /resume, /quit and the /kind draft.
          // The old inline check here blocked every command but /help and
          // left that whole section dead code.
          runCommandRef.current(value)
          setInput('')
          return
        }
        createSessionFlow(value, { kind: draftKindRef.current, mode: draftModeRef.current, cwd: process.cwd() })
        setInput('')
        return
      }

      // Inline "new session" flow: the next message is the objective. The mode
      // shown in the input line (Tab) is the mode the session is created with.
      if (overlayRef.current === 'new-session') {
        setOverlay(null)
        const cur = activeRef.current!
        createSessionFlow(value, {
          kind: draftKindRef.current,
          mode: draftModeRef.current,
          cwd: cur.config.cwd,
          model: cur.config.model,
        })
        setInput('')
        return
      }

      if (value.startsWith('/')) {
        runCommandRef.current(value)
        return
      }
      runnerRef.current?.send(value)
      if (!runnerRef.current?.isRunning) {
        push({ kind: 'user', text: value })
        startRun()
      } else {
        push({ kind: 'note', text: 'follow-up queued — it will be applied at the next safe point', color: 'cyan', group: 'queue' })
      }
      refresh()
    },
    // overlay/drafts are read via refs inside the body, so this callback stays
    // fresh even when a keystroke reaches a not-yet-refreshed subscription.
    [push, startRun, createSessionFlow, refresh],
  )

  useInput((raw, key) => {
    lastActivityRef.current = Date.now()

    // ONE authoritative routing policy (src/tui/keymap.ts): the handler below
    // only performs the side effect of the resolved action, so no two
    // handlers can ever compete for the same keystroke.
    const action = resolveKey(raw, key, {
      view: activeRef.current ? 'session' : 'welcome',
      overlay: overlayRef.current,
      running: runnerRef.current?.isRunning ?? false,
      escArmed: escArmedRef.current,
    })

    switch (action.type) {
      case 'quit': {
        runnerRef.current?.pause()
        const current = sessionRef.current
        const done = current ? saveSession(current) : Promise.resolve()
        void done.then(() => exit())
        return
      }
      case 'overlay-input':
        return // the overlay component's own useInput owns these keys
      case 'close-overlay': {
        setOverlay(null)
        if (action.overlay === 'new-session') {
          // Restore the draft that was stashed when the entry was opened.
          setInput(inputCacheRef.current[activeIdRef.current] ?? '')
          push({ kind: 'note', text: 'new session cancelled', color: 'gray' })
        }
        return
      }
      case 'open-palette':
        setOverlay('palette')
        return
      case 'open-new-session':
        openNewSession()
        return
      case 'arm-interrupt':
        setEscArmed(true)
        push({ kind: 'note', text: 'press Esc again to interrupt the agent (state is saved)', color: 'yellow', group: 'esc' })
        escTimerRef.current = setTimeout(() => setEscArmed(false), 3000)
        return
      case 'interrupt':
        runnerRef.current?.pause()
        setEscArmed(false)
        if (escTimerRef.current) clearTimeout(escTimerRef.current)
        push({ kind: 'note', text: 'interrupted — state saved; send a message to resume', color: 'yellow' })
        return
      case 'toggle-sidebar':
        setSidebarOn((v) => !v)
        return
      case 'close-tab': {
        const current = activeRef.current
        if (!current) return
        // A closed tab must never keep writing into the transcript that
        // replaces it — stop its engine and drop the runner first.
        if (current.id === activeIdRef.current) {
          runnerRef.current?.pause()
          runnerRef.current = null
        }
        void saveSession(current).then(() => {
          const remaining = tabsRef.current.filter((s) => s.id !== current.id)
          delete entriesCacheRef.current[current.id]
          delete inputCacheRef.current[current.id]
          setTabs(remaining)
          tabsRef.current = remaining
          if (remaining.length === 0) {
            void exit()
            return
          }
          attachSession(remaining[remaining.length - 1]!)
        })
        return
      }
      case 'switch-tab':
        switchTab(action.dir)
        return
      case 'scroll':
        scrollOffsetRef.current = Math.max(0, scrollOffsetRef.current + (action.dir === -1 ? 6 : -6))
        setScrollOffset(scrollOffsetRef.current)
        return
      case 'scroll-latest':
        scrollOffsetRef.current = 0
        setScrollOffset(0)
        return
      case 'toggle-mode': {
        const cur = activeRef.current
        // Welcome draft, or the mode of the session BEING created (shown in
        // the input line) — never the old session's mode.
        if (!cur || overlayRef.current === 'new-session') {
          setDraftMode((m) => (m === 'build' ? 'plan' : 'build'))
          return
        }
        const next: Mode = cur.config.mode === 'build' ? 'plan' : 'build'
        cur.config.mode = next // the engine reads session.config.mode per turn
        // Grouped note: toggling PLAN/BUILD repeatedly updates ONE line.
        push({ kind: 'note', text: `mode → ${next.toUpperCase()} (applies from the next turn)`, color: 'yellow', group: 'mode' })
        void saveSession(cur)
        refresh()
        return
      }
      case 'toggle-kind':
        // Draft only: the kind of the session BEING created (welcome box or
        // the new-objective entry) — never the running session's policy.
        setDraftKind((k) => (k === 'task' ? 'goal' : 'task'))
        return
      case 'submit': {
        // Read the LIVE draft from the ref — a stale `input` here once made
        // Enter clear the box and submit an empty objective instead of the
        // typed text (the previous render's closure).
        const value = inputRef.current
        setInput('')
        inputRef.current = ''
        submit(value)
        return
      }
      case 'newline':
        setInput((prev) => prev + '\n')
        return
      case 'delete-back':
        setInput((prev) => prev.slice(0, -1))
        return
      case 'text':
        // Pasted or typed text: keep everything printable, newlines included.
        setInput((prev) => prev + action.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'))
        return
      case 'none':
        return
    }
  })

  // The Esc-armed timer must not outlive the component.
  useEffect(() => () => {
    if (escTimerRef.current) clearTimeout(escTimerRef.current)
  }, [])

  // Spinner + heartbeat while running.
  useEffect(() => {
    if (state !== 'running') return
    const id = setInterval(() => setSpinnerFrame((f) => f + 1), 120)
    return () => clearInterval(id)
  }, [state])

  const elapsedSec = active ? (Date.now() - new Date(active.usage.startedAt).getTime()) / 1000 : 0
  void tick

  const spin = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][spinnerFrame % 10] ?? '⠋'
  const idleSec = Math.round((Date.now() - lastActivityRef.current) / 1000)
  const workingLabel =
    state !== 'running' ? null : activeToolRef.current ? `running ${activeToolRef.current}…` : idleSec >= 2 ? `waiting on model ${idleSec}s…` : 'thinking…'

  const ctx = active ? contextStatus(active, config.context) : null
  const usedTokens = active ? estimateSessionTokens(active) : 0
  const ctxPercent = ctx ? Math.min(100, Math.round((usedTokens / ctx.requestBudgetTokens) * 100)) : 0

  const runCommand = (value: string): void => {
    const [cmd, ...rest] = value.slice(1).split(/\s+/)
    // Read the CURRENT session from the ref — a stale closure here once made
    // /mode and /status act on the previously active tab after a switch.
    const cur = activeRef.current
    const c = cur ? contextStatus(cur, config.context) : null
    const ut = cur ? estimateSessionTokens(cur) : 0
    const cp = c ? Math.min(100, Math.round((ut / c.requestBudgetTokens) * 100)) : 0

    // Commands that make sense before a session exists (welcome screen).
    switch (cmd) {
      case '':
      case 'help':
        push({ kind: 'note', text: helpText(), color: 'gray' })
        return
      case 'palette':
        setOverlay('palette')
        return
      case 'sessions':
        setOverlay('sessions')
        return
      case 'quit':
        if (sessionRef.current) void saveSession(sessionRef.current).then(() => exit())
        else exit()
        return
      case 'new':
        if (!cur) {
          // On the welcome screen the objective entry IS the screen itself.
          push({
            kind: 'note',
            text: 'the welcome screen is already the objective entry — type the task and press Enter (Tab: PLAN/BUILD · Ctrl+G: task/goal)',
            color: 'gray',
          })
          return
        }
        // The objective opens pre-filled in the focused entry — the mode that
        // will be used is visible BEFORE anything is created.
        openNewSession(rest.join(' '))
        return
      case 'kind': {
        const kind = rest[0] as SessionKind | undefined
        if (kind !== 'task' && kind !== 'goal') {
          push({ kind: 'note', text: 'usage: /kind task | /kind goal', color: 'red' })
          return
        }
        // Welcome: sets the DRAFT the next session is created with. In a
        // session this falls through to the session section below.
        if (cur) break
        setDraftKind(kind)
        push({ kind: 'note', text: `kind → ${kind.toUpperCase()} — new sessions start with it`, color: 'yellow', group: 'kind' })
        return
      }
      case 'resume': {
        const id = rest[0]
        if (!id) {
          push({ kind: 'note', text: 'usage: /resume <session-id> — or /sessions to browse', color: 'red' })
          return
        }
        switchToSession(id)
        return
      }
      default:
        break
    }

    if (!cur || !c) {
      push({ kind: 'note', text: `/${cmd} unlocks after the session starts`, color: 'gray' })
      return
    }

    switch (cmd) {
      case 'mode': {
        const mode = rest[0] as Mode | undefined
        if (mode !== 'plan' && mode !== 'build') {
          push({ kind: 'note', text: 'usage: /mode plan | /mode build', color: 'red' })
          return
        }
        cur.config.mode = mode
        push({ kind: 'note', text: `mode → ${mode.toUpperCase()} (applies from the next turn)`, color: 'yellow', group: 'mode' })
        void saveSession(cur)
        refresh()
        return
      }
      case 'kind': {
        const kind = rest[0] as SessionKind | undefined
        if (kind !== 'task' && kind !== 'goal') {
          push({ kind: 'note', text: 'usage: /kind task | /kind goal', color: 'red' })
          return
        }
        cur.config.kind = kind
        push({
          kind: 'note',
          text: `kind switched to ${kind.toUpperCase()} — ${kind === 'task' ? 'bounded work, completes when requirements are verified' : 'continuing goal, cycles until the state is reached'}`,
          color: 'yellow',
          group: 'kind',
        })
        void saveSession(cur)
        refresh()
        return
      }
      case 'context': {
        const sourceLabel = { configured: 'Configured by you', detected: 'Detected from model registry', fallback: 'Fallback — model unknown, window unconfirmed' }[c.source]
        push({
          kind: 'note',
          text:
            `context window ~${formatTokens(c.windowTokens)} tok (${sourceLabel})\n` +
            `request budget ~${formatTokens(c.requestBudgetTokens)} tok ` +
            `(window − ${formatTokens(c.maxOutputTokens)} reserved output − 2k safety)\n` +
            `estimated in-flight context ~${formatTokens(ut)} tok (~${cp}% of budget)\n` +
            `Override: set context.windowTokens in ${configFile}`,
          color: 'gray',
        })
        return
      }
      case 'settings': {
        push({
          kind: 'note',
          text:
            `provider: ${config.provider.id} · baseUrl: ${config.provider.baseUrl || '(default)'}\n` +
            `model: ${config.provider.model}\n` +
            `context override: ${config.context.windowTokens ? `~${formatTokens(config.context.windowTokens)} tok` : 'auto'} · reserved output ${formatTokens(config.context.maxOutputTokens)} tok\n` +
            `config file: ${configFile}\n` +
            `session model: ${cur.config.model ?? '(from config)'}`,
          color: 'gray',
        })
        return
      }
      case 'pause':
        runnerRef.current?.pause()
        push({ kind: 'note', text: 'paused — the session is saved; send a message to resume', color: 'yellow' })
        return
      case 'stop':
        cur.state = 'stopped'
        cur.stateReason = 'Stopped by the user.'
        runnerRef.current?.pause()
        void saveSession(cur).then(() => exit())
        return
      case 'status':
        push({
          kind: 'note',
          text: `turns ${cur.usage.turns}/${cur.config.budget.maxTurns} · model calls ${cur.usage.modelCalls}/${cur.config.budget.maxModelCalls} · elapsed budget ${Math.round(cur.config.budget.maxDurationMs / 60000)}min · evidence ${cur.evidence.length} · context ~${formatTokens(ut)}/${formatTokens(c.requestBudgetTokens)} tok · cost ${costLabel(cur.usage)}`,
          color: 'gray',
        })
        return
      case 'evidence': {
        const last = cur.evidence.slice(-10)
        if (!last.length) {
          push({ kind: 'note', text: 'no evidence recorded yet', color: 'gray' })
          return
        }
        for (const e of last) {
          push({
            kind: 'note',
            text: `[${e.ok ? 'OK' : 'FAIL'}] ${e.kind}${e.command ? ` \`${e.command}\` exit=${e.exitCode}` : ''} ${firstLine(e.output ?? '')}`,
            color: e.ok ? 'green' : 'red',
          })
        }
        return
      }
      case 'last': {
        const out = lastToolOutputRef.current
        push({
          kind: 'note',
          text: out ? out.slice(0, 4000) : 'no tool has run yet in this session view',
          color: 'gray',
        })
        return
      }
      default:
        push({ kind: 'note', text: `unknown command /${cmd} — try /help or Ctrl+K`, color: 'red' })
        return
    }
  }
  // Always point the submit path at the FREShest copy (fresh closures, refs).
  runCommandRef.current = runCommand

  /* ---------------- overlays (rendered in BOTH views) ---------------- */
  // Before this, overlays existed only in the session view: Ctrl+K on the
  // welcome screen set state that swallowed every key while showing nothing.
  const overlays =
    overlay === 'palette' ? (
      <CommandPalette
        onPick={(insert) => {
          setOverlay(null)
          setInput(insert)
          inputRef.current = insert
        }}
        onClose={() => setOverlay(null)}
      />
    ) : overlay === 'sessions' ? (
      <SessionBrowser
        cwd={active?.config.cwd ?? process.cwd()}
        currentId={active?.id ?? ''}
        onSwitch={(id) => {
          setOverlay(null)
          switchToSession(id)
        }}
        onClose={() => setOverlay(null)}
      />
    ) : null

  /* ---------------- welcome flow (no session yet) ---------------- */
  if (!active || !ctx) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <WelcomeScreen kind={draftKind} mode={draftMode} model={config.provider.model} hasSessions={cwdHasSessions} input={input} />
        {overlays}
        {/* Command feedback must be VISIBLE here: /help, /kind, /resume and
            friends push notes, and hiding them on the welcome screen made
            every "/" command look dead. Rendered below the box so a long
            /help scrolls out of view instead of cropping the input. */}
        {entries.length > 0 ? (
          <Box flexDirection="column">
            {entries.slice(-6).map((entry, i) => (
              <EntryView key={i} entry={entry} />
            ))}
          </Box>
        ) : null}
      </Box>
    )
  }

  /* ---------------- viewport: show the tail, honor scrollback ---------------- */
  const visibleCount = Math.max(6, termRows - CHROME_ROWS)
  const maxOffset = Math.max(0, entries.length - visibleCount)
  const offset = Math.min(scrollOffset, maxOffset)
  const startIndex = Math.max(0, entries.length - visibleCount - offset)
  const visibleEntries = entries.slice(startIndex)
  const sidebarVisible = sidebarOn && termColumns >= 100

  const tabInfos: TabInfo[] = tabs.map((s) => ({
    id: s.id,
    label: s.config.objective,
    state: s.id === activeId ? state : s.state,
  }))

  return (
    <Box flexDirection="column" paddingX={1}>
      <TabBar tabs={tabInfos} activeId={activeId} />
      {/* Header: identity + state, always visible */}
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          VARA <Text dimColor>· {truncate(active.config.objective, sidebarVisible ? 50 : 70)}</Text>
        </Text>
        <Text>
          <Text bold color={active.config.kind === 'task' ? 'blue' : 'magenta'}>
            {active.config.kind.toUpperCase()}
          </Text>
          <Text dimColor> · </Text>
          <Text color={active.config.mode === 'plan' ? 'yellow' : 'green'} bold>
            {active.config.mode.toUpperCase()}
          </Text>
          <Text dimColor> · </Text>
          <StateBadge state={state} />
        </Text>
      </Box>
      {/* Second status line only when the sidebar is hidden — no duplication. */}
      {!sidebarVisible ? (
        <Box justifyContent="space-between">
          <Text dimColor>
            {config.provider.id} · {model} · turn {active.usage.turns}
            {' · cost '}
            <Text color={active.usage.costPartial || active.usage.unpricedCalls > 0 ? 'yellow' : undefined}>
              {costLabel(active.usage)}
            </Text>
          </Text>
          <Text dimColor>
            context ~{formatTokens(usedTokens)}/{formatTokens(ctx.requestBudgetTokens)} tok{' '}
            <Text color={ctxPercent > 80 ? 'red' : undefined}>
              ({ctxPercent}%{ctx.source === 'fallback' ? ', fallback window' : ''})
            </Text>
          </Text>
        </Box>
      ) : null}

      {/* Overlays replace the viewport while open — closing restores it and
          the scroll position untouched. */}
      {overlays}

      {/* Conversation (viewport) + optional status sidebar */}
      {overlay ? null : (
        <Box flexDirection="row">
          <Box flexDirection="column" flexGrow={1} marginRight={sidebarVisible ? 1 : 0}>
            {offset > 0 ? (
              <Text dimColor>
                ▲ viewing older entries ({offset} back) — Ctrl+G jumps to latest
              </Text>
            ) : null}
            {visibleEntries.map((entry, i) => (
              <EntryView key={startIndex + i} entry={entry} />
            ))}
            {stream ? (
              <Box marginLeft={2}>
                <Text>{stream}</Text>
              </Box>
            ) : null}
          </Box>
          {sidebarVisible ? <Sidebar session={active} config={config} ctx={ctx} usedTokens={usedTokens} /> : null}
        </Box>
      )}

      {/* Input */}
      <Box>
        <Text color={state === 'running' ? 'green' : 'cyan'} bold>
          {overlay === 'new-session'
            ? `objective[${draftKind.toUpperCase()}·${draftMode.toUpperCase()}] ▸ `
            : state === 'running'
              ? `${spin} `
              : '› '}
        </Text>
        <Text>
          {input ||
            (overlay === 'new-session'
              ? 'describe what the new session should achieve…'
              : state === 'running'
                ? 'send a follow-up…'
                : 'message, or /help')}
        </Text>
      </Box>

      {/* Footer */}
      <Box justifyContent="space-between">
        <Text dimColor>
          {active.id} · {truncate(active.config.cwd, 32)} · {formatElapsed(elapsedSec)} · {active.usage.toolCalls} tools
        </Text>
        <Text dimColor>
          {workingLabel ? `${workingLabel} · ` : ''}Ctrl+K cmds · Alt+←/→ tabs · PgUp scroll · Ctrl+B panel · Ctrl+C quit
        </Text>
      </Box>
    </Box>
  )
}

let streamBuffer = ''

function flushStream(push: (e: Entry) => void, setStream: React.Dispatch<React.SetStateAction<string>>): void {
  if (streamBuffer) {
    push({ kind: 'assistant', text: streamBuffer })
    streamBuffer = ''
    setStream('')
  }
}
