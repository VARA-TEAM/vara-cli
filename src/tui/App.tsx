import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import type { EngineEvent, Mode, Session, SessionIntent, SessionKind, SessionState } from '../core/types.js'
import type { Provider } from '../llm/provider.js'
import type { VaraConfig } from '../config/config.js'
import { persistConfig, budgetFor } from '../config/config.js'
import { activate, activeProviderName, contextSettingsFor, defaultModelFor, ensureProviders } from '../config/providers.js'
import { buildProvider } from '../runtime.js'
import { ProviderManager } from './providers.js'
import { SessionRunner } from '../core/runner.js'
import { loadSession, saveSession, listSessions } from '../core/store.js'
import { createSession, CreateSessionInput } from '../core/session.js'
import { contextStatus, estimateSessionTokens, formatTokens } from '../core/context.js'
import { formatUsd } from '../llm/cost.js'
import { configFile } from '../config/paths.js'
import { StateBadge, formatElapsed } from './format.js'
import { EntryView, entryRows, firstLine, truncate, type Entry } from './entries.js'
import { appendEntry, replayTranscript, resumeBanner } from './history.js'
import { CommandPalette } from './palette.js'
import { SessionBrowser } from './sessions.js'
import { dispatchClick } from './clicks.js'
import { listCheckpoints } from '../tools/file-guard.js'
import { suggestions } from './complete.js'
import { COMMANDS } from './commands.js'
import { TabBar, nextTabId, type TabInfo } from './tabs.js'
import { Sidebar, SIDEBAR_WIDTH } from './sidebar.js'
import { PromptBox } from './prompt.js'
import { applyTheme, findTheme, glyph, SPINNER, tailRows, theme, THEMES, wrappedRows } from './theme.js'
import { HomeScreen, type DraftKind, type RecentSession } from './home.js'
import { SettingsScreen, type SkillRow } from './settings.js'
import { memoryReply, proposalReply } from './memory-commands.js'
import { discoverAllSkills, discoverSkills, scaffoldSkill, type Skill } from '../core/skills.js'
import { helpText } from './commands.js'
import { ZodError } from 'zod'
import { VERSION } from '../version.js'
import { McpHub } from '../mcp/hub.js'
import { makeSessionRunner } from '../core/runner-factory.js'
import { modeLabel, modeNames, resolveModeChoice } from '../core/modes.js'
import { McpScreen } from './mcp.js'
import { attachPath, cleanTitle, expandMentions } from './mentions.js'
import { adoptStaged } from '../core/attachments.js'
import { previews } from '../preview/manager.js'
import { checkForUpdate } from '../update/updater.js'
import { setModelThinking, thinkingFor, visionFor } from '../config/providers.js'
import { nextLevel } from '../llm/capabilities.js'
import { findModel } from '../llm/registry.js'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Markdown } from './markdown.js'
import { keySource } from '../runtime.js'
import { CONNECTORS, connectorServer, findConnector } from '../mcp/connectors.js'
import { listSecrets } from '../security/vault.js'
import { resolveKey, type Overlay } from './keymap.js'
import { agentLine, agentsText, applyAgentEvent, isBusy, swarmSummaryLine, type SwarmView } from './agents.js'
import { AgentsScreen } from './agents-view.js'
import { costCommand, sessionEngineLines } from '../core/cost-report.js'

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

/** Terminals shorter than this hide the sidebar (it would out-grow the frame). */
const SIDEBAR_MIN_ROWS = 30

export function App({ session, provider: initialProvider, config: initialConfig, autoStart }: Props): React.ReactElement {
  const { exit } = useApp()
  // The active provider/config are state: /providers, /model and /provider
  // swap them live, so every async callback reads them through refs.
  const [config, setConfig] = useState(() => ensureProviders(initialConfig))
  const [provider, setProvider] = useState(initialProvider)
  const configRef = useRef(config)
  const providerRef = useRef(provider)
  const hubRef = useRef<McpHub>(new McpHub())
  const updateRef = useRef<{ current: string; latest: string; url: string } | undefined>(undefined)
  configRef.current = config
  providerRef.current = provider
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
  // --- start screen: shown with no session, or as a "+ New" tab (Ctrl+N) ---
  const [homeOpen, setHomeOpen] = useState(false)
  const [recent, setRecent] = useState<RecentSession[]>([])
  const [homeSel, setHomeSel] = useState(-1)
  const [draftKind, setDraftKind] = useState<DraftKind>(() => (ensureProviders(initialConfig).agent.autoIntent ? 'auto' : 'task'))
  const [draftMode, setDraftMode] = useState<Mode>(() => initialConfig.agent.defaultMode)
  const [thinking, setThinking] = useState('')
  const [intent, setIntent] = useState<SessionIntent | null>(session?.intent ?? null)
  const [skillRows, setSkillRows] = useState<SkillRow[]>([])
  const [skillNames, setSkillNames] = useState<string[]>([])
  // Sub-agents (swarms) of the active session: the ref is the truth (events update it synchronously), the state re-renders.
  const agentsRef = useRef<SwarmView[]>([])
  const agentsCacheRef = useRef<Record<string, SwarmView[]>>({})
  const [agents, setAgents] = useState<SwarmView[]>([])
  const [keyMissing, setKeyMissing] = useState(false)

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
  /** Files added with /attach, waiting for the next message. */
  const pendingAttachRef = useRef<Array<{ block: string; name: string }>>([])
  /** Stale-closure shields for the input path. ink re-subscribes `useInput`
   * on every render, but a keystroke can arrive BEFORE the next subscription
   * flushes — the attached handler then belongs to the PREVIOUS render and
   * would read stale state (an Enter that reads an old `input` silently
   * submits an empty objective; an Esc that reads an old `overlay` misses).
   * Everything the handler reads therefore comes from these refs, written on
   * every render. */
  const overlayRef = useRef<Overlay>(null)
  const escArmedRef = useRef(false)
  const draftKindRef = useRef<DraftKind>('auto')
  const draftModeRef = useRef<Mode>('build')
  const homeOpenRef = useRef(false)
  const homeSelRef = useRef(-1)
  const recentRef = useRef<RecentSession[]>([])

  tabsRef.current = tabs
  inputRef.current = input
  overlayRef.current = overlay
  escArmedRef.current = escArmed
  draftKindRef.current = draftKind
  draftModeRef.current = draftMode
  homeOpenRef.current = homeOpen
  homeSelRef.current = homeSel
  recentRef.current = recent
  const active = tabs.find((t) => t.id === activeId) ?? null
  const activeRef = useRef<Session | null>(active)
  activeRef.current = active
  const model = active?.config.model ?? config.provider.model

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  /**
   * Streaming tokens arrive dozens of times a second; repainting the whole
   * frame for each one makes the screen shimmer. Batch them to ~12 fps.
   */
  const thinkingRef = useRef('')
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleLive = useCallback(() => {
    if (liveTimerRef.current) return
    liveTimerRef.current = setTimeout(() => {
      liveTimerRef.current = null
      setStream(streamBuffer)
      setThinking(thinkingRef.current)
    }, 80)
  }, [])
  useEffect(
    () => () => {
      if (liveTimerRef.current) clearTimeout(liveTimerRef.current)
    },
    [],
  )

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
          if (event.state !== 'running') {
            thinkingRef.current = ''
            setThinking('')
          }
          if (event.reason) push({ kind: 'note', text: event.reason, color: 'gray', group: 'state' })
          break
        case 'intent':
          setIntent(event.intent)
          break
        case 'subagent': {
          agentsRef.current = applyAgentEvent(agentsRef.current, event)
          if (activeIdRef.current) agentsCacheRef.current[activeIdRef.current] = agentsRef.current
          setAgents(agentsRef.current)
          const row = agentsRef.current.find((s) => s.swarm === (event.swarm ?? 1))?.rows.find((r) => r.id === event.id)
          if (row) {
            push({
              kind: 'note',
              text: `agent #${event.swarm ?? 1} · ${agentLine(row, Date.now())}`,
              color: event.status === 'failed' ? 'red' : event.status === 'done' ? 'green' : event.status === 'waiting' || event.status === 'skipped' ? 'gray' : 'cyan',
              group: `sub-${event.swarm ?? 1}-${event.id}`,
            })
          }
          break
        }
        case 'swarm_report': {
          agentsRef.current = applyAgentEvent(agentsRef.current, event)
          if (activeIdRef.current) agentsCacheRef.current[activeIdRef.current] = agentsRef.current
          setAgents(agentsRef.current)
          const v = agentsRef.current.find((s) => s.swarm === event.swarm)
          if (v) push({ kind: 'note', text: swarmSummaryLine(v), color: event.failed ? 'yellow' : 'green', group: `swarm-${event.swarm}` })
          break
        }
        case 'approval_request':
          push({
            kind: 'note',
            text: `┌ The agent asks permission\n│ ${event.request.title}\n${event.request.detail.split('\n').slice(0, 12).map((l) => `│ ${l}`).join('\n')}\n└ /approve to allow · /deny to decline`,
            color: 'yellow',
            group: `approval-${event.request.id}`,
          })
          break
        case 'approval_resolved':
          push({ kind: 'note', text: event.approved ? `${glyph.ok} approved` : `${glyph.fail} declined`, color: event.approved ? 'green' : 'red', group: `approval-${event.id}` })
          break
        case 'thinking':
          thinkingRef.current = (thinkingRef.current + event.text).slice(-400)
          scheduleLive()
          break
        case 'text':
          streamingRef.current = true
          streamBuffer += event.delta
          scheduleLive()
          return // no extra re-render: scheduleLive batches token updates
        case 'tool_start':
          thinkingRef.current = ''
          setThinking('')
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
        case 'usage_limit':
          push({ kind: 'note', text: event.message, color: event.level === 'warn' ? 'yellow' : 'red', group: 'limit' })
          break
        case 'compacted':
          push({ kind: 'note', text: `${event.auto ? 'auto-compact' : 'compact'}: ${event.folded} messages folded into a summary (~${event.savedTokens.toLocaleString()} tokens fewer on every later request)`, color: 'gray', group: 'compact' })
          break
        case 'route':
          // Every decision is in the audit log; the screen shows the ones worth reading: a tier change or an escalation.
          if (event.reason.includes('escalat') || event.reason.includes('eco')) push({ kind: 'note', text: `model: ${event.reason}`, color: 'gray', group: 'route' })
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

  /** One place builds runners, so model/provider switches can never leave a stale one. */
  const makeRunner = useCallback(
    (s: Session) =>
      makeSessionRunner({
        session: s,
        provider: () => providerRef.current,
        config: () => configRef.current,
        hub: hubRef.current,
        onEvent: handleEvent,
        update: () => (configRef.current.updates.check ? updateRef.current : undefined),
        // The agent may change its own setup — each change waits for /approve.
        applyConfig: async (next) => {
          configRef.current = next
          setConfig(next)
          await persistConfig(next)
        },
      }),
    [handleEvent],
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
      setIntent(next.intent ?? null)
      setHomeOpen(false)
      runnerRef.current = makeRunner(next)

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
      agentsRef.current = agentsCacheRef.current[next.id] ?? []
      setAgents(agentsRef.current)
      scrollOffsetRef.current = 0
      setScrollOffset(0)
      refresh()
    },
    [makeRunner, refresh],
  )

  // The mount-time runner (a resumed session) lives in runnerRef alone — one
  // owner, no second ref that can drift out of sync with the tabs.
  if (!runnerRef.current && session) {
    runnerRef.current = makeRunner(session)
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

  // A quiet, non-blocking "update available" note (at most one request a day; off in /settings).
  useEffect(() => {
    void checkForUpdate({ enabled: configRef.current.updates.check }).then((n) => {
      updateRef.current = n ?? undefined
      if (n) push({ kind: 'note', text: `VARA ${n.latest} is available (you have ${n.current}) — quit and run: vara update`, color: 'cyan' })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadRecent = useCallback(async () => {
    try {
      const all = await listSessions()
      const here = process.cwd().replace(/[\\/]+$/, '').toLowerCase()
      setRecent(
        all
          .filter((x) => x.cwd.replace(/[\\/]+$/, '').toLowerCase() === here)
          .slice(0, 5)
          .map((x) => ({ id: x.id, objective: cleanTitle(x.objective), state: x.state as SessionState, updatedAt: x.updatedAt })),
      )
    } catch {
      setRecent([])
    }
  }, [])

  const loadSkillRows = useCallback(async () => {
    try {
      const cwd = activeRef.current?.config.cwd ?? process.cwd()
      const all = await discoverAllSkills(cwd, configRef.current.skills.disabled)
      setSkillRows(all.map((x) => ({ name: x.name, description: x.description, source: x.source, enabled: x.enabled })))
      const offHere = new Set(activeRef.current?.config.disabledSkills ?? [])
      setSkillNames(all.filter((x) => x.enabled && !offHere.has(x.name)).map((x) => x.name))
    } catch {
      /* skills are optional */
    }
  }, [])

  // MCP: connect the configured servers in the background; re-sync on any change.
  const mcpKey = JSON.stringify(config.mcp.servers)
  useEffect(() => {
    void hubRef.current.sync(config.mcp.servers as never)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcpKey])
  useEffect(() => {
    const hub = hubRef.current
    const off = hub.onChange(() => setTick((t) => t + 1))
    return () => {
      off()
      hub.closeAll()
    }
  }, [])

  // Warn on the start screen when the active provider has no key.
  useEffect(() => {
    void keySource(config.provider).then((k) => setKeyMissing(k === 'none')).catch(() => {})
  }, [config.provider])

  useEffect(() => {
    void loadRecent()
    void loadSkillRows()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openHome = useCallback(
    (prefill = '') => {
      const current = activeRef.current
      if (current) inputCacheRef.current[current.id] = inputRef.current
      setInput(prefill)
      inputRef.current = prefill
      setHomeSel(-1)
      setHomeOpen(true)
      void loadRecent()
    },
    [loadRecent],
  )

  const closeHome = useCallback(() => {
    const current = activeRef.current
    setHomeOpen(false)
    const draft = current ? (inputCacheRef.current[current.id] ?? '') : ''
    setInput(draft)
    inputRef.current = draft
  }, [])

  const switchTab = useCallback(
    (dir: -1 | 1) => {
      const infos: TabInfo[] = tabsRef.current.map((s) => ({ id: s.id, label: s.config.objective, state: s.state }))
      const nextId = nextTabId(infos, activeIdRef.current, dir)
      const next = tabsRef.current.find((s) => s.id === nextId)
      if (homeOpenRef.current) {
        closeHome()
        return
      }
      if (!next || next.id === activeIdRef.current) return
      // Each tab keeps its own draft: save the current input, restore the target's.
      inputCacheRef.current[activeIdRef.current] = inputRef.current
      void saveSession(sessionRef.current ?? next).then(() => {
        attachSession(next)
        setInput(inputCacheRef.current[next.id] ?? '')
      })
    },
    [attachSession, closeHome],
  )

  /** A tab was clicked: the same switch the keyboard does, to that tab. */
  const selectTab = useCallback(
    (id: string) => {
      if (homeOpenRef.current) closeHome()
      if (id === activeIdRef.current) return
      const next = tabsRef.current.find((s) => s.id === id)
      if (!next) return
      inputCacheRef.current[activeIdRef.current] = inputRef.current
      void saveSession(sessionRef.current ?? next).then(() => {
        attachSession(next)
        setInput(inputCacheRef.current[next.id] ?? '')
      })
    },
    [attachSession, closeHome],
  )

  /**
   * Create a session from an entered objective AND start it — the single path
   * behind the welcome screen, Ctrl+N and `/new <objective>`. Before this,
   * `/new <objective>` sent a follow-up to the CURRENT session and sessions
   * created with Ctrl+N never started at all (the objective just sat there).
   */
  const createSessionFlow = useCallback(
    (objective: string, opts: { kind: DraftKind; mode: Mode; cwd: string; model?: string }) => {
      try {
        const auto = opts.kind === 'auto'
        const parsed = CreateSessionInput.parse({
          kind: auto ? 'task' : opts.kind,
          mode: opts.mode,
          objective,
          cwd: opts.cwd,
          verifyCommand: configRef.current.defaultVerifyCommand || undefined,
          model: opts.model ?? configRef.current.provider.model,
          auto,
        })
        const created = createSession(parsed, configRef.current)
        // Images wait in staging until the session exists; they must be in its folder before the first turn reads them.
        void adoptStaged(created.id, objective)
          .then(() => saveSession(created))
          .then(() => {
            attachSession(created)
            push({ kind: 'user', text: objective })
            startRun()
          })
          .catch((err: Error) => push({ kind: 'note', text: err.message, color: 'red' }))
      } catch (err) {
        // Never show raw validation JSON: say what is wrong in one line.
        const text = err instanceof ZodError ? err.issues.map((i) => i.message).join('; ') : (err as Error).message
        push({ kind: 'note', text, color: 'red' })
      }
    },
    [attachSession, push, startRun],
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

  /** Manager edits (add/remove/test/context): persist and mirror, keep running as is. */
  const onProvidersChange = useCallback((next: VaraConfig) => {
    configRef.current = next
    setConfig(next)
    void persistConfig(next)
  }, [])

  /**
   * Switch the ACTIVE provider/model live: build the provider first (so a
   * missing key fails here, visibly, and nothing changes), then swap config,
   * provider and the session's runner together.
   */
  const useConfig = useCallback(
    async (next: VaraConfig) => {
      setOverlay(null)
      const name = activeProviderName(next)
      let built
      try {
        built = await buildProvider(next)
      } catch (err) {
        push({ kind: 'note', text: `cannot use ${name}: ${(err as Error).message}`, color: 'red' })
        return
      }
      configRef.current = next
      setConfig(next)
      void persistConfig(next)
      providerRef.current = built.provider
      setProvider(built.provider)
      const cur = activeRef.current
      let text = `now using ${name} · ${next.provider.model}`
      if (cur) {
        const wasRunning = runnerRef.current?.isRunning ?? false
        runnerRef.current?.pause()
        cur.config.model = next.provider.model
        void saveSession(cur)
        runnerRef.current = makeRunner(cur)
        if (wasRunning) text += ' — agent paused, send a message to continue'
        else text += ' (applies from the next turn)'
      }
      push({ kind: 'note', text, color: 'yellow', group: 'model' })
      refresh()
    },
    [push, makeRunner, refresh],
  )
  const useConfigRef = useRef(useConfig)
  useConfigRef.current = useConfig

  const submit = useCallback(
    (raw: string) => {
      const value = raw.trim()
      const onHome = !activeRef.current || homeOpenRef.current

      // Home: Enter on a highlighted recent session opens it; otherwise the
      // message (anything — even "hi") starts a new session.
      if (onHome) {
        if (!value && homeSelRef.current >= 0) {
          const r = recentRef.current[homeSelRef.current]
          if (r) {
            setHomeOpen(false)
            switchToSession(r.id)
          }
          return
        }
        if (!value) return
        if (value.startsWith('/')) {
          runCommandRef.current(value)
          setInput('')
          return
        }
        // attachSession sets sessionRef synchronously; a second Enter in the
        // same frame (before the re-render) must not create a duplicate.
        if (!activeRef.current && sessionRef.current) return
        const homeCwd = activeRef.current?.config.cwd ?? process.cwd()
        setInput('')
        const extra = pendingAttachRef.current.map((a) => a.block)
        pendingAttachRef.current = []
        void expandMentions(value, homeCwd, { extra }).then(({ text, files, skipped }) => {
          createSessionFlow(text, { kind: draftKindRef.current, mode: draftModeRef.current, cwd: homeCwd })
          if (files.length) push({ kind: 'note', text: `attached ${files.join(', ')}`, color: 'gray' })
          for (const k of skipped) push({ kind: 'note', text: `not attached — ${k}`, color: 'yellow' })
        })
        return
      }

      if (!value) return
      if (value.startsWith('/')) {
        runCommandRef.current(value)
        return
      }
      const sendCwd = activeRef.current?.config.cwd ?? process.cwd()
      const extra = pendingAttachRef.current.map((a) => a.block)
      pendingAttachRef.current = []
      void expandMentions(value, sendCwd, { extra }).then(async ({ text, files, skipped }) => {
        if (sessionRef.current) await adoptStaged(sessionRef.current.id, text)
        runnerRef.current?.send(text)
        if (!runnerRef.current?.isRunning) {
          push({ kind: 'user', text: value })
          startRun()
        } else {
          push({ kind: 'note', text: 'queued — the agent will see it at the next safe point', color: 'cyan', group: 'queue' })
        }
        if (files.length) push({ kind: 'note', text: `attached ${files.join(', ')}`, color: 'gray' })
        for (const k of skipped) push({ kind: 'note', text: `not attached — ${k}`, color: 'yellow' })
        refresh()
      })
    },
    [push, startRun, createSessionFlow, refresh, switchToSession],
  )

  const completionsFor = (text: string) =>
    suggestions(text, { commands: COMMANDS, skills: skillNames, mcpServers: Object.keys(configRef.current.mcp.servers) })

  useInput((raw, key) => {
    lastActivityRef.current = Date.now()

    // ONE authoritative routing policy (src/tui/keymap.ts): the handler below
    // only performs the side effect of the resolved action, so no two
    // handlers can ever compete for the same keystroke.
    const onHome = !activeRef.current || homeOpenRef.current
    const action = resolveKey(raw, key, {
      view: onHome ? 'home' : 'session',
      overlay: overlayRef.current,
      running: runnerRef.current?.isRunning ?? false,
      escArmed: escArmedRef.current,
      canLeaveHome: homeOpenRef.current && tabsRef.current.length > 0,
      inputEmpty: inputRef.current.length === 0,
      hasCompletion: completionsFor(inputRef.current).length > 0,
    })

    switch (action.type) {
      case 'quit': {
        void previews.stopAll()
        hubRef.current.closeAll()
        runnerRef.current?.pause()
        const current = sessionRef.current
        const done = current ? saveSession(current) : Promise.resolve()
        void done.then(() => exit())
        return
      }
      case 'overlay-input':
        return // the overlay component's own useInput owns these keys
      case 'close-overlay':
        setOverlay(null)
        return
      case 'open-palette':
        setOverlay('palette')
        return
      case 'open-settings':
        void loadSkillRows()
        setOverlay('settings')
        return
      case 'open-home':
        openHome()
        return
      case 'close-home':
        closeHome()
        return
      case 'home-move': {
        const n = recentRef.current.length
        if (!n) return
        const cur = homeSelRef.current
        const next = action.dir === 1 ? Math.min(n - 1, cur + 1) : cur - 1
        setHomeSel(Math.max(-1, next))
        return
      }
      case 'complete': {
        const first = completionsFor(inputRef.current)[0]
        if (first) {
          setInput(first.apply)
          inputRef.current = first.apply
        }
        return
      }
      case 'click':
        dispatchClick(action.x, action.y)
        return
      case 'wheel':
      case 'scroll-line': {
        const step = action.type === 'wheel' ? -action.delta * 3 : -action.dir
        scrollOffsetRef.current = Math.max(0, scrollOffsetRef.current + step)
        setScrollOffset(scrollOffsetRef.current)
        return
      }
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
        if (homeOpenRef.current) {
          closeHome()
          return
        }
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
        scrollOffsetRef.current = Math.max(0, scrollOffsetRef.current + (action.dir === -1 ? 8 : -8))
        setScrollOffset(scrollOffsetRef.current)
        return
      case 'scroll-latest':
        scrollOffsetRef.current = 0
        setScrollOffset(0)
        return
      case 'toggle-mode': {
        const cur = activeRef.current
        // Start screen: the mode of the session BEING created — never an old session's.
        if (!cur || homeOpenRef.current) {
          setDraftMode((m) => (m === 'build' ? 'plan' : 'build'))
          return
        }
        // Tab cycles plan → build → each custom mode (config.json: `modes`).
        const names = modeNames(configRef.current.modes)
        const nextName = names[(names.indexOf(modeLabel(cur.config)) + 1) % names.length] ?? 'plan'
        const choice = resolveModeChoice(configRef.current.modes, nextName)
        if (!choice.ok) return
        cur.config.mode = choice.mode // the engine reads session.config.mode per turn
        if (choice.customMode) cur.config.customMode = choice.customMode
        else delete cur.config.customMode
        // Grouped note: toggling repeatedly updates ONE line.
        push({ kind: 'note', text: `mode → ${nextName.toUpperCase()} (applies from the next turn)`, color: 'yellow', group: 'mode' })
        void saveSession(cur)
        refresh()
        return
      }
      case 'toggle-kind':
        // Draft only: the kind of the session BEING created.
        setDraftKind((k) => (k === 'auto' ? 'task' : k === 'task' ? 'goal' : 'auto'))
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
    const id = setInterval(() => setSpinnerFrame((f) => f + 1), 250)
    return () => clearInterval(id)
  }, [state])

  const elapsedSec = active ? (Date.now() - new Date(active.usage.startedAt).getTime()) / 1000 : 0
  void tick

  const spin = SPINNER[spinnerFrame % SPINNER.length] ?? '⠋'
  const idleSec = Math.round((Date.now() - lastActivityRef.current) / 1000)
  const workingLabel =
    state !== 'running' ? null : activeToolRef.current ? `running ${activeToolRef.current}…` : idleSec >= 2 ? `waiting on model ${idleSec}s…` : 'thinking…'

  const ctx = active ? contextStatus(active, contextSettingsFor(config, active.config.model ?? config.provider.model)) : null
  const usedTokens = active ? estimateSessionTokens(active) : 0
  const ctxPercent = ctx ? Math.min(100, Math.round((usedTokens / ctx.requestBudgetTokens) * 100)) : 0

  const runCommand = (value: string): void => {
    const [cmd, ...rest] = value.slice(1).split(/\s+/)
    // Read the CURRENT session from the ref — a stale closure here once made
    // /mode and /status act on the previously active tab after a switch.
    const cur = activeRef.current
    const c = cur ? contextStatus(cur, contextSettingsFor(config, cur.config.model ?? config.provider.model)) : null
    const ut = cur ? estimateSessionTokens(cur) : 0
    const cp = c ? Math.min(100, Math.round((ut / c.requestBudgetTokens) * 100)) : 0

    // Commands that make sense before a session exists (welcome screen).
    switch (cmd) {
      case '':
      case 'help':
        setOverlay('help')
        return
      case 'palette':
        setOverlay('palette')
        return
      case 'providers':
      case 'setup':
        setOverlay('providers')
        return
      case 'mcp':
        setOverlay('mcp')
        return
      case 'connectors': {
        void (async () => {
          const have = new Set((await listSecrets()).map((s) => s.name))
          const servers = configRef.current.mcp.servers
          if (rest[0] === 'add') {
            const c = findConnector(rest[1] ?? '')
            if (!c) return push({ kind: 'note', text: `unknown connector "${rest[1] ?? ''}" — /connectors lists them`, color: 'red' })
            if (servers[c.id]) return push({ kind: 'note', text: `${c.name} is already connected`, color: 'gray' })
            if (c.oauth) return push({ kind: 'note', text: `${c.name} signs in with your browser. Run: vara connectors login ${c.id}  (or press Connect in the web UI: Settings → Connectors)`, color: 'yellow' })
            const missing = c.secrets.filter((s) => !have.has(s.name))
            if (missing.length) {
              return push({ kind: 'note', text: `${c.name} needs ${missing.map((s) => s.name).join(', ')} in the vault. Run: vara connectors add ${c.id}  (it asks for the value without showing it)`, color: 'yellow' })
            }
            onProvidersChange({ ...configRef.current, mcp: { ...configRef.current.mcp, servers: { ...servers, [c.id]: connectorServer(c) as never } } })
            return push({ kind: 'note', text: `${c.name} added — connecting…`, color: 'green' })
          }
          const lines = CONNECTORS.map((c) => `${servers[c.id] ? (servers[c.id]!.enabled === false ? 'off' : 'on ') : '   '}  ${c.id.padEnd(20)} ${c.description}`)
          push({ kind: 'note', text: ['Connectors (on = connected):', ...lines, '', 'Add one: /connectors add <id> · tokens: vara connectors add <id>'].join('\n'), color: 'gray' })
        })()
        return
      }
      case 'think': {
        const m = configRef.current.provider.model
        const { support, level } = thinkingFor(configRef.current, m)
        if (!support) {
          push({ kind: 'note', text: `${m} has no thinking control on this endpoint (only reasoning models do).`, color: 'gray' })
          return
        }
        const want = rest[0]
        if (!want) {
          push({ kind: 'note', text: `thinking: ${level} — options: ${support.levels.join(' | ')} (${support.note}). /think <level>, or /think next`, color: 'gray', group: 'think' })
          return
        }
        const next = want === 'next' ? nextLevel(support, level) : (want as (typeof support.levels)[number])
        if (!support.levels.includes(next)) {
          push({ kind: 'note', text: `${m} supports: ${support.levels.join(' | ')}`, color: 'red' })
          return
        }
        onProvidersChange(setModelThinking(configRef.current, activeProviderName(configRef.current), m, next))
        push({ kind: 'note', text: `thinking → ${next} for ${m} (work turns; chat stays fast)`, color: 'yellow', group: 'think' })
        return
      }
      case 'attach': {
        const arg = value.replace(/^\/attach\s*/, '').trim().replace(/^(["'])(.*)\1$/, '$2')
        if (!arg) {
          const waiting = pendingAttachRef.current
          push({ kind: 'note', text: waiting.length ? `waiting for your next message: ${waiting.map((a) => a.name).join(', ')}` : 'usage: /attach <file> — an image, a PDF or a text file (or drag a file onto the terminal)', color: 'gray' })
          return
        }
        void attachPath(resolve(cur?.config.cwd ?? process.cwd(), arg))
          .then((st) => {
            pendingAttachRef.current.push({ block: st.block, name: st.name })
            const model = cur?.config.model ?? configRef.current.provider.model
            const blind = st.kind === 'image' && !visionFor(configRef.current, model)
            const kb = Math.max(1, Math.round(st.size / 1024))
            const extra = (blind ? ` · ${model} cannot view images, the agent will only be told one was attached` : '') + (st.note ? ` · ${st.note}` : '')
            push({ kind: 'note', text: `attached ${st.name} (${st.kind}, ${kb} KB) — it goes with your next message${extra}`, color: blind ? 'yellow' : 'green' })
          })
          .catch((err: Error) => push({ kind: 'note', text: `cannot attach: ${err.message}`, color: 'red' }))
        return
      }
      case 'preview': {
        if (!cur) {
          push({ kind: 'note', text: 'start a session first', color: 'gray' })
          return
        }
        const sub = rest[0] ?? ''
        const info = previews.get(cur.id)
        if (sub === 'stop') {
          void previews.stop(cur.id).then(() => push({ kind: 'note', text: 'preview stopped', color: 'green' }))
          return
        }
        if (sub === 'logs') {
          push({ kind: 'note', text: previews.logs(cur.id, 40) || '(no preview output yet)', color: 'gray' })
          return
        }
        if (sub === 'start') {
          const command = value.replace(/^\/preview\s+start\s*/, '').trim()
          if (!command) {
            push({ kind: 'note', text: 'usage: /preview start <command>  e.g. /preview start npm run dev', color: 'gray' })
            return
          }
          push({ kind: 'note', text: `starting ${command} …`, color: 'gray' })
          void previews
            .start(cur.id, { command, cwd: cur.config.cwd })
            .then((i) => push({ kind: 'note', text: i.state === 'running' ? `preview running — open ${i.url}` : `preview did not start: ${i.error ?? i.state}`, color: i.state === 'running' ? 'green' : 'red' }))
            .catch((err: Error) => push({ kind: 'note', text: err.message, color: 'red' }))
          return
        }
        push({ kind: 'note', text: info ? `preview ${info.state}${info.url ? ` — open ${info.url}` : ''}${info.error ? ` — ${info.error}` : ''}` : 'no preview running — /preview start <command>, or ask the agent to start the dev server', color: 'gray' })
        return
      }
      case 'export': {
        if (!cur) {
          push({ kind: 'note', text: 'nothing to export yet', color: 'gray' })
          return
        }
        const file = join(cur.config.cwd, rest[0] ?? `vara-${cur.id}.md`)
        const md = [`# ${cleanTitle(cur.config.objective)}`, '', `session ${cur.id} · ${cur.config.model ?? ''} · ${cur.state}`, '']
        for (const m of cur.transcript) {
          if (m.role === 'user' && /^\[(ENGINE|SYSTEM|STATE|BUDGET|FOLLOW-UP INSTRUCTION)/.test(m.content)) continue
          if (m.role === 'user') md.push('## You', '', m.content.split('\n\n[attached files]')[0]!, '')
          else if (m.role === 'assistant' && m.content.trim()) md.push('## VARA', '', m.content, '')
          for (const c of m.toolCalls ?? []) md.push(`> tool: \`${c.name}\` ${c.arguments.slice(0, 200)}`, '')
        }
        void writeFile(file, md.join('\n'), 'utf8')
          .then(() => push({ kind: 'note', text: `exported → ${file}`, color: 'green' }))
          .catch((err: Error) => push({ kind: 'note', text: `export failed: ${err.message}`, color: 'red' }))
        return
      }
      case 'undo': {
        if (!cur || !runnerRef.current) {
          push({ kind: 'note', text: 'no session yet', color: 'gray' })
          return
        }
        const n = Math.max(1, Math.min(20, Number(rest[0]) || 1))
        void runnerRef.current.undo(n).then((r) => {
          if (r === 'busy') return push({ kind: 'note', text: 'the agent is working: stop it first (Esc), then /undo', color: 'yellow' })
          const lines = [...r.restored.map((x) => `✓ ${x.path} — ${x.what}`), ...r.failed.map((x) => `✗ ${x.path} — ${x.why}`)]
          push({ kind: 'note', text: lines.length ? ['undo:', ...lines].join(String.fromCharCode(10)) : 'nothing to undo', color: r.failed.length ? 'yellow' : 'gray' })
        })
        return
      }
      case 'checkpoints': {
        if (!cur) {
          push({ kind: 'note', text: 'no session yet', color: 'gray' })
          return
        }
        void listCheckpoints(cur.id).then((list) =>
          push({
            kind: 'note',
            text: list.length ? ['changes /undo can put back (newest last):', ...list.slice(-15).map((c) => `  #${c.id} ${c.action} ${c.path}`)].join(String.fromCharCode(10)) : 'no file changes recorded in this session',
            color: 'gray',
          }),
        )
        return
      }
      case 'compact': {
        if (!cur || !runnerRef.current) {
          push({ kind: 'note', text: 'no session yet', color: 'gray' })
          return
        }
        push({ kind: 'note', text: 'compacting…', color: 'gray', group: 'compact' })
        void runnerRef.current.compact(rest.join(' ')).then((r) => {
          if (r === 'busy') push({ kind: 'note', text: 'the agent is working: stop it first (Esc), then /compact', color: 'yellow' })
          else if (!r) push({ kind: 'note', text: 'nothing worth folding yet (the conversation is still short)', color: 'gray', group: 'compact' })
          refresh()
        })
        return
      }
      case 'autocompact': {
        const arg = (rest[0] ?? '').toLowerCase()
        const pct = Number(arg.replace('%', ''))
        const next = structuredClone(config)
        if (arg === 'on' || arg === 'off') next.context.autoCompact = arg === 'on'
        else if (Number.isFinite(pct) && pct >= 40 && pct <= 95) (next.context.autoCompact = true), (next.context.autoCompactAt = pct / 100)
        else {
          push({ kind: 'note', text: `auto-compact is ${config.context.autoCompact ? `on, at ${Math.round(config.context.autoCompactAt * 100)}% of the window` : 'off'}. Use /autocompact on | off | 40-95`, color: 'gray' })
          return
        }
        setConfig(next)
        void persistConfig(next)
        push({ kind: 'note', text: `auto-compact ${next.context.autoCompact ? `on, at ${Math.round(next.context.autoCompactAt * 100)}%` : 'off'}`, color: 'gray' })
        return
      }
      case 'cost': {
        if (!cur) {
          push({ kind: 'note', text: 'no session yet', color: 'gray' })
          return
        }
        push({ kind: 'note', text: [costReport(cur), ...sessionEngineLines(cur)].join('\n'), color: 'gray' })
        return
      }
      case 'limit':
      case 'savings':
      case 'route': {
        const out = costCommand(cmd, rest, configRef.current, cur ?? undefined)
        if (out.config) void useConfigRef.current(out.config)
        push({ kind: 'note', text: out.text, color: out.error ? 'red' : 'gray' })
        return
      }
      case 'models':
        setOverlay('models')
        return
      case 'provider': {
        const target = rest[0]
        const entry = target ? configRef.current.providers[target] : undefined
        if (!target || !entry) {
          push({
            kind: 'note',
            text: `usage: /provider <name> [model] — configured: ${Object.keys(configRef.current.providers).join(', ') || 'none'} (or /providers to add one)`,
            color: 'red',
          })
          return
        }
        const chosen = rest[1] ?? defaultModelFor(entry)
        if (!chosen) {
          push({ kind: 'note', text: `${target} has no models yet — open /providers and press r to fetch them`, color: 'yellow' })
          return
        }
        void useConfigRef.current(activate(configRef.current, target, chosen))
        return
      }
      case 'sessions':
        setOverlay('sessions')
        return
      case 'quit':
        if (sessionRef.current) void saveSession(sessionRef.current).then(() => exit())
        else exit()
        return
      case 'new':
        // Opens the start screen as a new tab — nothing has to be typed first.
        openHome(rest.join(' '))
        return
      case 'settings':
        void loadSkillRows()
        setOverlay('settings')
        return
      case 'theme': {
        const name = rest[0]
        const found = name ? findTheme(name) : undefined
        if (!found) {
          push({ kind: 'note', text: `usage: /theme <name> — ${THEMES.map((t) => t.name).join(', ')}`, color: name ? 'red' : 'gray' })
          return
        }
        onProvidersChange({ ...configRef.current, ui: { ...configRef.current.ui, theme: found.name } })
        applyTheme(found.name)
        push({ kind: 'note', text: `theme → ${found.label}`, color: 'gray', group: 'theme' })
        return
      }
      case 'memory': {
        const r = memoryReply(rest, cur?.config.cwd ?? process.cwd(), configRef.current.memory)
        if (r.enable !== undefined) onProvidersChange({ ...configRef.current, memory: { ...configRef.current.memory, enabled: r.enable } })
        push({ kind: 'note', text: r.text, color: r.error ? 'red' : 'gray' })
        return
      }
      case 'skills': {
        if (['proposals', 'show', 'approve', 'reject'].includes(rest[0] ?? '')) {
          void proposalReply(rest).then((r) => {
            push({ kind: 'note', text: r.text, color: r.error ? 'red' : 'gray' })
            if (r.skillsChanged) void loadSkillRows()
          })
          return
        }
        if (rest[0] === 'new') {
          const name = rest[1]
          if (!name) {
            push({ kind: 'note', text: 'usage: /skills new <name> [project]', color: 'red' })
            return
          }
          void scaffoldSkill(name, rest[2] === 'project' ? 'project' : 'user', cur?.config.cwd ?? process.cwd())
            .then((file) => {
              push({ kind: 'note', text: `created ${file} — edit it, then it is available to the agent`, color: 'gray' })
              void loadSkillRows()
            })
            .catch((err: Error) => push({ kind: 'note', text: err.message, color: 'red' }))
          return
        }
        void discoverAllSkills(cur?.config.cwd ?? process.cwd(), configRef.current.skills.disabled).then((all) => {
          const offHere = new Set(cur?.config.disabledSkills ?? [])
          const lines = all.map((x) => `  ${x.enabled && !offHere.has(x.name) ? glyph.ok : '○'} ${x.name.padEnd(14)} ${x.description}  [${x.source}]${x.enabled && offHere.has(x.name) ? ' (off in this session)' : ''}`)
          push({
            kind: 'note',
            text: `Skills (the agent loads one when it fits; /skill <name> forces it):\n${lines.join('\n')}\n\nAdd your own: /skills new <name> [project] · toggle in /settings · /disable <name> or /enable <name> for this session only`,
            color: 'gray',
          })
        })
        return
      }
      case 'skill': {
        const name = rest[0]
        if (!name) {
          push({ kind: 'note', text: 'usage: /skill <name> [what to apply it to]', color: 'red' })
          return
        }
        invokeSkill(name, rest.slice(1).join(' '))
        return
      }
      case 'kind': {
        const kind = rest[0] as DraftKind | undefined
        if (kind !== 'task' && kind !== 'goal' && kind !== 'auto') {
          push({ kind: 'note', text: 'usage: /kind auto | task | goal', color: 'red' })
          return
        }
        // On the start screen this sets the DRAFT; in a session it falls
        // through to the session section below (auto is a draft-only value).
        if (cur && !homeOpenRef.current && kind !== 'auto') break
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
        const names = modeNames(configRef.current.modes)
        const choice = rest[0] ? resolveModeChoice(configRef.current.modes, rest[0]) : null
        if (!choice || !choice.ok) {
          push({ kind: 'note', text: `usage: /mode ${names.join(' | ')}${choice && !choice.ok ? ` — ${choice.error}` : ''}`, color: 'red' })
          return
        }
        cur.config.mode = choice.mode
        if (choice.customMode) cur.config.customMode = choice.customMode
        else delete cur.config.customMode
        push({ kind: 'note', text: `mode → ${modeLabel(cur.config).toUpperCase()} (applies from the next turn)`, color: 'yellow', group: 'mode' })
        void saveSession(cur)
        refresh()
        return
      }
      case 'enable':
      case 'disable': {
        const name = rest[0]
        const on = cmd === 'enable'
        if (!name) {
          push({ kind: 'note', text: `usage: /${cmd} <skill or MCP server> — for this session only`, color: 'red' })
          return
        }
        const isMcp = !!configRef.current.mcp.servers[name]
        void discoverAllSkills(cur.config.cwd, []).then((all) => {
          const isSkill = all.some((x) => x.name === name.toLowerCase())
          if (!isMcp && !isSkill) {
            push({ kind: 'note', text: `no skill or MCP server named "${name}"`, color: 'red' })
            return
          }
          const key = isMcp ? 'disabledMcp' : 'disabledSkills'
          const id = isMcp ? name : name.toLowerCase()
          const off = new Set(cur.config[key] ?? [])
          if (on) off.delete(id)
          else off.add(id)
          cur.config[key] = [...off]
          void saveSession(cur)
          void loadSkillRows()
          push({ kind: 'note', text: `${isMcp ? 'MCP server' : 'skill'} ${id} → ${on ? 'on' : 'off'} for this session`, color: 'yellow', group: `toggle-${id}` })
          refresh()
        })
        return
      }
      case 'agents': {
        const sub = rest[0]
        if (sub === 'cancel') {
          const target = rest[1] && rest[1] !== 'all' ? rest[1] : undefined
          const ok = runnerRef.current?.cancelAgents(target) ?? false
          push({ kind: 'note', text: ok ? `cancelling ${target ? `agent ${target}` : 'every agent'}…` : target ? `agent "${target}" is not running` : 'no agents are running', color: ok ? 'yellow' : 'gray' })
          return
        }
        if (sub === 'report') {
          const last = agentsRef.current[agentsRef.current.length - 1]
          push({ kind: 'note', text: last?.report ? last.report.merged.slice(0, 4000) : agentsText(agentsRef.current), color: 'gray' })
          return
        }
        if (sub === 'list') {
          push({ kind: 'note', text: agentsText(agentsRef.current), color: 'gray' })
          return
        }
        setOverlay('agents')
        return
      }
      case 'approve':
      case 'deny': {
        const pending = cur.pendingApprovals ?? []
        const target = rest[0] ?? pending[0]?.id
        if (!target || !runnerRef.current?.resolveApproval(target, cmd === 'approve')) {
          push({ kind: 'note', text: 'nothing is waiting for approval', color: 'gray' })
        }
        return
      }
      case 'kind': {
        const kind = rest[0] as SessionKind | undefined
        if (kind !== 'task' && kind !== 'goal') {
          push({ kind: 'note', text: 'usage: /kind task | /kind goal', color: 'red' })
          return
        }
        cur.config.auto = false
        cur.config.kind = kind
        // Update budget when switching kind
        const newBudget = kind === 'task' ? config.budgets.task : config.budgets.goal
        cur.config.budget = newBudget
        push({
          kind: 'note',
          text: `kind switched to ${kind.toUpperCase()} — ${kind === 'task' ? 'bounded work, completes when requirements are verified' : 'continuing goal, cycles until the state is reached or user stops'}`,
          color: 'yellow',
          group: 'kind',
        })
        void saveSession(cur)
        refresh()
        return
      }
      case 'model': {
        const modelId = rest.join(' ').trim()
        if (!modelId) {
          setOverlay('models')
          return
        }
        void useConfigRef.current(activate(configRef.current, activeProviderName(configRef.current), modelId))
        return
      }
      case 'models':
        setOverlay('models')
        return
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
        if (cmd && skillNames.includes(cmd)) {
          invokeSkill(cmd, rest.join(' '))
          return
        }
        push({ kind: 'note', text: `unknown command /${cmd} — try /help or Ctrl+K`, color: 'red' })
        return
    }
  }

  /** `/skill <name> …`: ask the agent to apply a skill (it loads the body itself). */
  function invokeSkill(name: string, about: string): void {
    const wanted = name.toLowerCase()
    if (!skillNames.includes(wanted)) {
      push({ kind: 'note', text: `no enabled skill "${name}" — see /skills`, color: 'red' })
      return
    }
    const text = `Use the "${wanted}" skill${about ? `: ${about}` : ' on the current work.'}`
    const cur = activeRef.current
    if (!cur || homeOpenRef.current) {
      createSessionFlow(text, { kind: 'task', mode: draftModeRef.current, cwd: process.cwd() })
      return
    }
    runnerRef.current?.send(text)
    if (!runnerRef.current?.isRunning) {
      push({ kind: 'user', text })
      startRun()
    }
  }
  // Always point the submit path at the FREShest copy (fresh closures, refs).
  runCommandRef.current = runCommand

  /* ---------------- overlays (rendered on the start screen AND in a session) ---------------- */
  const overlayRows = Math.max(4, Math.min(14, termRows - 14))
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
    ) : overlay === 'help' ? (
      <HelpView onClose={() => setOverlay(null)} />
    ) : overlay === 'providers' || overlay === 'models' ? (
      <ProviderManager
        config={config}
        initial={overlay === 'models' ? 'models' : 'list'}
        maxRows={overlayRows}
        onChange={onProvidersChange}
        onUse={(next) => void useConfig(next)}
        onClose={() => setOverlay(null)}
      />
    ) : overlay === 'mcp' ? (
      <McpScreen config={config} hub={hubRef.current} maxRows={overlayRows} onChange={onProvidersChange} onClose={() => setOverlay(null)} />
    ) : overlay === 'settings' ? (
      <SettingsScreen
        config={config}
        skills={skillRows}
        maxRows={overlayRows}
        onChange={(next) => {
          applyTheme(next.ui.theme)
          onProvidersChange(next)
          setDraftMode((m) => (m === configRef.current.agent.defaultMode ? m : m))
        }}
        onAction={(id) => {
          if (id === 'providers') setOverlay('providers')
          if (id === 'mcp') setOverlay('mcp')
        }}
        onClose={() => {
          setOverlay(null)
          void loadSkillRows()
        }}
      />
    ) : overlay === 'agents' ? (
      <AgentsScreen swarms={agents} maxRows={overlayRows} onCancel={(id) => runnerRef.current?.cancelAgents(id) ?? false} onClose={() => setOverlay(null)} />
    ) : overlay === 'sessions' ? (
      <SessionBrowser
        cwd={active?.config.cwd ?? process.cwd()}
        currentId={active?.id ?? ''}
        onSwitch={(id) => {
          setOverlay(null)
          setHomeOpen(false)
          switchToSession(id)
        }}
        onClose={() => setOverlay(null)}
      />
    ) : null

  const fullscreen = config.ui.fullscreen
  /** One row shorter than the terminal: ink redraws the whole screen when a frame is as tall as the terminal. */
  const frameHeight = fullscreen ? Math.max(8, termRows - 1) : undefined
  const showHome = !active || !ctx || homeOpen
  const tabInfos: TabInfo[] = tabs.map((s) => ({
    id: s.id,
    label: cleanTitle(s.config.objective),
    state: s.id === activeId ? state : s.state,
  }))

  /* ---------------- start screen ---------------- */
  if (showHome) {
    const notes = entries.slice(-3)
    return (
      <Box flexDirection="column" paddingX={1} height={frameHeight}>
        {tabs.length > 0 ? <TabBar tabs={tabInfos} activeId={activeId} homeActive onSelect={selectTab} onNew={openHome} /> : null}
        {overlays ? (
          overlays
        ) : (
          <HomeScreen
            input={input}
            kind={draftKind}
            mode={draftMode}
            providerName={activeProviderName(config)}
            model={config.provider.model}
            cwd={process.cwd()}
            recent={recent}
            selected={homeSel}
            columns={termColumns}
            version={VERSION}
            notice={keyMissing ? `No API key for ${activeProviderName(config)} — type /providers to connect a model` : undefined}
          />
        )}
        {notes.length > 0 && !overlay ? (
          <Box flexDirection="column" height={Math.min(6, notes.reduce((n, e) => n + entryRows(e, termColumns - 2), 0))} overflow="hidden">
            {notes.map((entry, i) => (
              <EntryView key={i} entry={entry} />
            ))}
          </Box>
        ) : null}
      </Box>
    )
  }

  /* ---------------- session view: fit the tail into the terminal rows ---------------- */
  const sidebarVisible = config.ui.sidebar && sidebarOn && termColumns >= 100 && termRows >= SIDEBAR_MIN_ROWS
  const rule = glyph.rule.repeat(Math.max(10, termColumns - 2))
  const showTabs = tabs.length > 1
  const inputRows = Math.min(6, wrappedRows(input || ' ', Math.max(10, termColumns - 10)))
  // Fixed chrome: tabs (0/1) + header 1 + status 1 (no sidebar) + rule 1 +
  // working line 1 + prompt (border 2 + input rows) + footer 1 + scroll hint 1.
  const chromeRows = (showTabs ? 1 : 0) + (sidebarVisible ? 0 : 1) + 6 + 2 + inputRows
  const contentWidth = Math.max(20, termColumns - 2 - (sidebarVisible ? SIDEBAR_WIDTH + 1 : 0))
  const bodyRows = Math.max(4, (frameHeight ?? termRows) - chromeRows)
  const streamShown = stream ? tailRows(stream, contentWidth - 4, Math.max(2, Math.floor(bodyRows / 2))) : ''
  const streamRows = streamShown ? wrappedRows(streamShown, contentWidth - 4) + 1 : 0
  const entryBudget = Math.max(2, bodyRows - streamRows - (scrollOffset > 0 ? 1 : 0))

  // Walk back from the newest visible entry, filling the row budget. A row
  // budget (not an entry count) keeps the frame inside the terminal.
  const maxOffset = Math.max(0, entries.length - 1)
  const offset = Math.min(scrollOffset, maxOffset)
  const endIndex = entries.length - offset
  let startIndex = endIndex
  let used = 0
  // An entry taller than what is left is still included (the body clips it at
  // the top, so its END stays visible) — skipping it hid long answers entirely.
  while (startIndex > 0 && used < entryBudget) {
    used += entryRows(entries[startIndex - 1]!, contentWidth)
    startIndex--
  }
  const visibleEntries = entries.slice(startIndex, endIndex)

  const promptAccent = state === 'running' ? theme.ok : theme.brand
  const promptLabel = `${state === 'running' ? spin : glyph.prompt} `
  const promptPlaceholder = state === 'running' ? 'send a follow-up…' : state === 'ready' ? 'reply, or ask for work…' : 'message, or /help'
  const wide = termColumns >= 110
  const hints = wide
    ? 'Ctrl+N new · Ctrl+K cmds · Ctrl+O settings · Alt+←/→ tabs · Ctrl+B panel · Ctrl+C quit'
    : termColumns >= 70
      ? 'Ctrl+N new · Ctrl+K cmds · Ctrl+O settings'
      : 'Ctrl+K cmds · Ctrl+C quit'
  const shownIntent = intent ?? active.config.kind
  const intentColor = shownIntent === 'chat' ? theme.chat : shownIntent === 'question' ? theme.question : shownIntent === 'goal' ? theme.goal : theme.task
  const thinkingTail = config.ui.showThinking && thinking ? thinking.replace(/\s+/g, ' ').trim().slice(-90) : ''

  return (
    <Box flexDirection="column" paddingX={1} height={frameHeight}>
      {showTabs ? <TabBar tabs={tabInfos} activeId={activeId} onSelect={selectTab} onNew={openHome} /> : null}
      {/* Header: identity + state, always visible */}
      <Box justifyContent="space-between" flexShrink={0}>
        <Box flexShrink={1}>
          <Text bold color={theme.brand}>
            VARA
          </Text>
          <Text color={theme.muted} wrap="truncate-end">
            {' '}
            {glyph.sep} {truncate(cleanTitle(active.config.objective), Math.max(10, termColumns - 46))}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text>
            <Text bold color={intentColor}>
              {shownIntent.toUpperCase()}
            </Text>
            <Text color={theme.muted}> {glyph.sep} </Text>
            <Text color={active.config.mode === 'plan' ? theme.plan : theme.build} bold>
              {modeLabel(active.config).toUpperCase()}
            </Text>
            <Text color={theme.muted}> {glyph.sep} </Text>
          </Text>
          <StateBadge state={state} />
        </Box>
      </Box>
      {/* Second status line only when the sidebar is hidden — no duplication. */}
      {!sidebarVisible ? (
        <Box justifyContent="space-between" flexShrink={0}>
          <Text color={theme.muted} wrap="truncate-end">
            {activeProviderName(config)} · {model} · turn {active.usage.turns}
            {' · cost '}
            <Text color={active.usage.costPartial || active.usage.unpricedCalls > 0 ? theme.warn : undefined}>
              {costLabel(active.usage)}
            </Text>
          </Text>
          <Text color={theme.muted} wrap="truncate-end">
            ctx ~{formatTokens(usedTokens)}/{formatTokens(ctx.requestBudgetTokens)}{' '}
            <Text color={ctxPercent > 80 ? theme.err : undefined}>
              ({ctxPercent}%{ctx.source === 'fallback' ? ', assumed window' : ''})
            </Text>
          </Text>
        </Box>
      ) : null}
      <Box flexShrink={0}>
        <Text color={theme.border}>{rule}</Text>
      </Box>

      {/* Body: an overlay, or the conversation + optional side panel. flexGrow
          pins the prompt to the bottom whatever the transcript length. */}
      <Box flexGrow={1} flexShrink={1} flexBasis={0} minHeight={0} flexDirection="row" overflow="hidden">
        {overlays ? (
          <Box flexDirection="column" flexGrow={1}>
            {overlays}
          </Box>
        ) : (
          <>
            <Box flexDirection="column" flexGrow={1} flexShrink={1} justifyContent="flex-end" overflow="hidden" marginRight={sidebarVisible ? 1 : 0}>
              {offset > 0 ? (
                <Text color={theme.warn}>
                  {'▼'} {offset} newer entries below {glyph.sep} scroll down or Ctrl+G for the latest
                </Text>
              ) : null}
              {visibleEntries.map((entry, i) => (
                <Box key={startIndex + i} flexShrink={0} flexDirection="column">
                  <EntryView entry={entry} compact={!config.ui.toolDetails} />
                </Box>
              ))}
              {streamShown ? (
                <Box marginTop={1} flexShrink={0}>
                  <Box width={2} flexShrink={0}>
                    <Text color={theme.assistant}>{glyph.dot}</Text>
                  </Box>
                  <Box flexGrow={1} flexShrink={1}>
                    <Markdown text={streamShown} />
                  </Box>
                </Box>
              ) : null}
            </Box>
            {sidebarVisible ? (
              <Sidebar session={active} config={config} ctx={ctx} usedTokens={usedTokens} sections={config.ui.sections} skillNames={skillNames} think={thinkingFor(config, model).level} mcpReady={hubRef.current.tools(new Set(active.config.disabledMcp ?? [])).length} agents={agents} now={Date.now()} />
            ) : null}
          </>
        )}
      </Box>

      {/* Live activity line — always one row so the layout never jumps. */}
      <Box flexShrink={0}>
        {workingLabel ? (
          <Text color={theme.ok} wrap="truncate-end">
            {spin} {workingLabel}
            <Text color={theme.muted}>
              {' '}
              {glyph.sep} {formatElapsed(elapsedSec)} {glyph.sep} Esc Esc to interrupt
              {thinkingTail ? ` ${glyph.sep} ${thinkingTail}` : ''}
            </Text>
          </Text>
        ) : (
          <Text color={theme.muted}> </Text>
        )}
      </Box>

      {/* Input */}
      {completionsFor(input).length > 0 ? (
        <Box flexDirection="column" paddingLeft={2}>
          {completionsFor(input).map((c, i) => (
            <Text key={c.label} dimColor={i > 0}>
              <Text color={theme.brand}>{c.label}</Text>
              <Text dimColor>  {c.detail.slice(0, Math.max(10, termColumns - c.label.length - 20))}</Text>
              {i === 0 ? <Text dimColor>   (Tab)</Text> : null}
            </Text>
          ))}
        </Box>
      ) : null}
      <PromptBox
        value={input}
        label={promptLabel}
        placeholder={promptPlaceholder}
        accent={promptAccent}
        width={Math.max(20, termColumns - 2)}
      />

      {/* Footer */}
      <Box justifyContent="space-between" flexShrink={0}>
        <Text color={theme.muted} wrap="truncate-end">
          {active.id} {glyph.sep} {truncate(active.config.cwd, wide ? 36 : 20)} {glyph.sep} {formatElapsed(elapsedSec)} {glyph.sep} {active.usage.toolCalls} tools
        </Text>
        <Text color={theme.muted} wrap="truncate-end">
          {hints}
        </Text>
      </Box>
    </Box>
  )
}

/** /help: keys and commands in one box. Any key closes it. */
function HelpView({ onClose }: { onClose: () => void }): React.ReactElement {
  useInput(() => onClose())
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1} marginBottom={1} overflow="hidden">
      <Text bold color={theme.brand}>
        Help
      </Text>
      <Text>{helpText()}</Text>
      <Text color={theme.muted}>any key closes</Text>
    </Box>
  )
}

/** Plain-text cost report: spend, tokens, cache hit rate and what the cost engine saved. */
function costReport(s: Session): string {
  const u = s.usage
  const sv = s.savings ?? { compactedChars: 0, dedupedReads: 0, cheapCalls: 0, subagents: 0 }
  const input = u.inputTokens
  const cached = u.cachedInputTokens
  const total = (input ?? 0) + (cached ?? 0)
  const hit = cached !== null && total > 0 ? Math.round(((cached ?? 0) / total) * 100) : null
  const spec = findModel(s.config.model ?? '')
  const p = spec?.pricing
  // What the cached tokens would have cost at the full input price, minus what they did cost.
  const cacheSaved = p && cached ? (cached / 1e6) * (p.inputPer1M - (p.cachedInputPer1M ?? p.inputPer1M)) : null
  const compactSaved = p ? ((sv.compactedChars / 4) / 1e6) * p.inputPer1M * Math.max(1, s.usage.turns / 2) : null
  const money = (v: number | null) => (v === null ? 'n/a' : `~$${v.toFixed(v < 0.01 ? 4 : 2)}`)
  return [
    `cost ${costLabel(u)} · ${u.modelCalls} model calls · ${u.toolCalls} tool calls`,
    `tokens in ${input === null ? '?' : formatTokens(input)} · cached ${cached === null ? '?' : formatTokens(cached)}${hit === null ? '' : ` (${hit}% of input served from cache)`} · out ${u.outputTokens === null ? '?' : formatTokens(u.outputTokens)}`,
    `saved by VARA:`,
    `  prompt caching        ${money(cacheSaved)}${cached ? '' : '  (no cache hits reported by this provider yet)'}`,
    `  compaction            ${formatTokens(Math.round(sv.compactedChars / 4))} tokens of old tool output shortened  ${money(compactSaved)}`,
    `  repeated reads        ${sv.dedupedReads} file reads answered from context`,
    `  cheap model           ${sv.cheapCalls} calls routed to the cheaper model`,
    `  sub-agents            ${sv.subagents} ran with their own small context`,
  ].join('\n')
}

let streamBuffer = ''


function flushStream(push: (e: Entry) => void, setStream: React.Dispatch<React.SetStateAction<string>>): void {
  if (streamBuffer) {
    push({ kind: 'assistant', text: streamBuffer })
    streamBuffer = ''
    setStream('')
  }
}
