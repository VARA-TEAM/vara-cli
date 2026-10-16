import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api, auth, onUnauthorized } from '../api'
import { makeRegistry, RegistryContext, useRegisterCommands, type Cmd } from '../commands'
import { useMe, useResource, useSessions } from '../hooks'
import { LangContext, applyLang, savedLang, useT, type Lang } from '../i18n'
import { DEFAULT_PREFS, PrefsContext, savedPrefs, storePrefs, type Prefs } from '../prefs'
import { THEMES, applyTheme, savedTheme, type Theme } from '../theme'
import type { ModelsInfo, ProvidersState } from '../types'
import { Team } from './Admin'
import { Home } from './Home'
import { FolderDialog, type FolderInfo } from './Folder'
import { Help } from './Help'
import { Join, SignIn } from './Misc'
import { Palette } from './Palette'
import { SessionPage } from './SessionPage'
import { Settings, isTab } from './Settings'
import { Sidebar, type Route } from './Sidebar'
import { ToastHost, useToast } from './toast'
import { Workbench } from './Workbench'

/** `#/s/<id>`, `#/team`, `#/settings[/tab]`, anything else = home. */
export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, '')
  const s = /^\/s\/([\w-]+)$/.exec(h)
  if (s) return { page: 'session', id: s[1]! }
  if (h === '/team') return { page: 'team' }
  const st = /^\/settings(?:\/(\w+))?$/.exec(h)
  if (st) return isTab(st[1]) ? { page: 'settings', tab: st[1] } : { page: 'settings' }
  return { page: 'home' }
}
export function routeToHash(r: Route): string {
  return r.page === 'session' ? `#/s/${r.id}` : r.page === 'team' ? '#/team' : r.page === 'settings' ? (r.tab ? `#/settings/${r.tab}` : '#/settings') : '#/'
}

/**
 * First thing on load: pick up access from the URL.
 *   /#token=…      the owner's secret link (moved to sessionStorage, then removed from the address bar)
 *   /join/<token>  a guest invite (shown as the join screen)
 */
function bootstrap(): { invite: string | null } {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''))
  const token = hash.get('token')
  if (token) {
    auth.set(token, 'session')
    history.replaceState(null, '', location.pathname)
  }
  const m = /^\/join\/([\w-]+)$/.exec(location.pathname)
  return { invite: m ? m[1]! : null }
}
const boot = bootstrap()

function hideUpdate(): void {
  try {
    sessionStorage.setItem('vara.update.hidden', '1')
  } catch {
    /* only a convenience */
  }
}

export function App() {
  const [lang, setLangState] = useState<Lang>(savedLang)
  const [theme, setTheme] = useState<Theme>(savedTheme)
  const [prefs, setPrefsState] = useState<Prefs>(() => (typeof localStorage === 'undefined' ? DEFAULT_PREFS : savedPrefs()))
  const [authed, setAuthed] = useState(() => !!auth.get())
  const [invite, setInvite] = useState<string | null>(boot.invite)
  const [route, setRouteState] = useState<Route>(() => parseRoute(location.hash))
  const [navOpen, setNavOpen] = useState(false)
  const [scopeAll, setScopeAllState] = useState(() => {
    try {
      return localStorage.getItem('vara.scope') === 'all'
    } catch {
      return false
    }
  })
  const setScopeAll = useCallback((v: boolean) => {
    setScopeAllState(v)
    try {
      localStorage.setItem('vara.scope', v ? 'all' : 'here')
    } catch {
      /* a convenience */
    }
  }, [])
  const [models, setModels] = useState<ModelsInfo | null>(null)
  const registry = useRef(makeRegistry()).current

  useEffect(() => applyLang(lang), [lang])
  useEffect(() => applyTheme(theme), [theme])
  useEffect(() => onUnauthorized(() => setAuthed(false)), [])
  useEffect(() => {
    const on = (): void => setRouteState(parseRoute(location.hash))
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])

  const setRoute = useCallback((r: Route) => {
    location.hash = routeToHash(r)
    setRouteState(r)
  }, [])
  const setPrefs = useCallback((p: Partial<Prefs>) => {
    setPrefsState((cur) => {
      const next = { ...cur, ...p }
      storePrefs(next)
      return next
    })
  }, [])

  const { me, error: meError } = useMe(authed)
  const { sessions, reload: reloadSessions, loaded: sessionsLoaded } = useSessions(!!me, scopeAll)

  useEffect(() => {
    if (!me) return
    api<ModelsInfo>('GET', '/api/models').then(setModels).catch(() => {})
  }, [me])

  const ctx = { lang, setLang: setLangState }

  if (invite && !authed) {
    return (
      <LangContext.Provider value={ctx}>
        <Join invite={invite} onJoined={() => (setInvite(null), setAuthed(true))} />
      </LangContext.Provider>
    )
  }
  if (!authed) {
    return (
      <LangContext.Provider value={ctx}>
        <SignIn />
      </LangContext.Provider>
    )
  }

  return (
    <LangContext.Provider value={ctx}>
      <PrefsContext.Provider value={{ prefs, setPrefs }}>
        <RegistryContext.Provider value={registry}>
          <ToastHost>
            <Shell
              me={me}
              meError={meError}
              sessions={sessions}
              route={route}
              setRoute={setRoute}
              models={models}
              reloadSessions={reloadSessions}
              theme={theme}
              setTheme={setTheme}
              navOpen={navOpen}
              setNavOpen={setNavOpen}
              scopeAll={scopeAll}
              setScopeAll={setScopeAll}
              sessionsLoaded={sessionsLoaded}
              signOut={() => (auth.clear(), setAuthed(false))}
            />
          </ToastHost>
        </RegistryContext.Provider>
      </PrefsContext.Provider>
    </LangContext.Provider>
  )
}

function Shell({
  me,
  meError,
  sessions,
  route,
  setRoute,
  models,
  reloadSessions,
  theme,
  setTheme,
  navOpen,
  setNavOpen,
  scopeAll,
  setScopeAll,
  sessionsLoaded,
  signOut,
}: {
  me: ReturnType<typeof useMe>['me']
  meError: string | null
  sessions: ReturnType<typeof useSessions>['sessions']
  route: Route
  setRoute: (r: Route) => void
  models: ModelsInfo | null
  reloadSessions: () => void
  theme: Theme
  setTheme: (t: Theme) => void
  navOpen: boolean
  setNavOpen: (v: boolean) => void
  scopeAll: boolean
  setScopeAll: (v: boolean) => void
  sessionsLoaded: boolean
  signOut: () => void
}) {
  const t = useT()
  const toast = useToast()
  const { lang, setLang } = useContext(LangContext)
  const [palette, setPalette] = useState(false)
  const [help, setHelp] = useState(false)
  const [updateHidden, setUpdateHidden] = useState(() => {
    try {
      return sessionStorage.getItem('vara.update.hidden') !== null
    } catch {
      return false
    }
  })
  const [folder, setFolder] = useState<FolderInfo | null>(null)
  const [pickFolder, setPickFolder] = useState(false)
  const owner = me?.role === 'owner'
  const loadFolder = useCallback(() => {
    if (owner) api<FolderInfo>('GET', '/api/folder').then(setFolder).catch(() => {})
  }, [owner])
  useEffect(loadFolder, [loadFolder])
  const providers = useResource<ProvidersState>(owner ? '/api/manage/providers' : null)
  const open = useCallback((id: string) => setRoute({ page: 'session', id }), [setRoute])

  // Commands that exist everywhere: places to go, appearance.
  const globals: Cmd[] = useMemo(() => {
    const list: Cmd[] = []
    const add = (c: Cmd): void => void list.push(c)
    add({ id: 'g:new', slash: 'new', group: 'go', title: t('newSession'), shortcut: 'Ctrl Shift O', run: () => setRoute({ page: 'home' }) })
    if (owner) {
      add({ id: 'g:team', slash: 'team', group: 'go', title: t('admin'), description: t('cmd_teamHelp'), run: () => setRoute({ page: 'team' }) })
      add({ id: 'g:providers', slash: 'providers', group: 'settings', title: t('t_models'), description: t('cmd_providersHelp'), run: () => setRoute({ page: 'settings', tab: 'models' }) })
      add({ id: 'g:agent', slash: 'agent', group: 'settings', title: t('t_agent'), description: t('cmd_agentHelp'), run: () => setRoute({ page: 'settings', tab: 'agent' }) })
      add({ id: 'g:gateway', slash: 'gateway', group: 'settings', title: t('t_gateways'), description: t('cmd_gatewayHelp'), run: () => setRoute({ page: 'settings', tab: 'gateways' }) })
      add({ id: 'g:skills', slash: 'skills', group: 'settings', title: t('t_skills'), description: t('cmd_skillsHelp'), run: () => setRoute({ page: 'settings', tab: 'skills' }) })
      add({ id: 'g:memory', slash: 'memory', group: 'settings', title: t('t_memory'), description: t('cmd_memoryHelp'), run: () => setRoute({ page: 'settings', tab: 'memory' }) })
      add({ id: 'g:models', slash: 'models', group: 'settings', title: t('cmd_models'), description: t('cmd_modelsHelp'), run: () => setRoute({ page: 'settings', tab: 'models' }) })
      add({ id: 'g:connectors', slash: 'connectors', group: 'settings', title: t('t_connectors'), description: t('cmd_connectorsHelp'), run: () => setRoute({ page: 'settings', tab: 'connectors' }) })
      add({
        id: 'g:provider',
        slash: 'provider',
        args: '<name> [model]',
        options: providers.data?.providers.map((p) => p.name) ?? [],
        group: 'settings',
        title: t('cmd_provider'),
        description: t('cmd_providerHelp'),
        run: async (a) => {
          const [name = '', model] = a.trim().split(/\s+/)
          const p = providers.data?.providers.find((x) => x.name.toLowerCase() === name.toLowerCase())
          if (!p) return toast(t('cmd_noProvider', { n: name || '…' }), 'err')
          try {
            providers.set(await api<ProvidersState>('POST', '/api/manage/providers/activate', { name: p.name, ...(model ? { model } : {}) }))
            toast(t('p_nowDefault', { model: model ?? p.label }))
          } catch (e) {
            toast((e as Error).message, 'err')
          }
        },
      })
      add({ id: 'g:mcp', slash: 'mcp', group: 'settings', title: t('t_mcp'), description: t('cmd_mcpHelp'), run: () => setRoute({ page: 'settings', tab: 'mcp' }) })
    }
    add({ id: 'g:palette', slash: 'palette', group: 'go', title: t('pal_title'), shortcut: 'Ctrl K', run: () => setPalette(true) })
    add({ id: 'g:help', slash: 'help', group: 'go', title: t('cmd_help'), description: t('cmd_helpHelp'), run: () => setHelp(true) })
    add({
      id: 'g:sessions',
      slash: 'sessions',
      args: '[--all]',
      options: ['--all'],
      group: 'go',
      title: t('cmd_sessions'),
      description: t('cmd_sessionsHelp'),
      run: (a) => {
        if (a.trim() === '--all') setScopeAll(true)
        setNavOpen(true)
        window.dispatchEvent(new Event('vara:sessions'))
      },
    })
    add({
      id: 'g:resume',
      slash: 'resume',
      args: '<id>',
      options: sessions.slice(0, 12).map((x) => x.id),
      group: 'go',
      title: t('cmd_resume'),
      description: t('cmd_resumeHelp'),
      run: (a) => {
        const q = a.trim().toLowerCase()
        const hits = q ? sessions.filter((x) => x.id.toLowerCase().startsWith(q)) : []
        if (hits.length === 1) return setRoute({ page: 'session', id: hits[0]!.id })
        toast(hits.length ? t('cmd_resumeMany', { n: hits.length }) : t('cmd_resumeNone', { q: q || '…' }), 'err')
      },
    })
    add({ id: 'g:settings', slash: 'settings', group: 'settings', title: t('settings'), run: () => setRoute({ page: 'settings' }) })
    add({ id: 'g:theme', slash: 'theme', args: '<name>', options: THEMES.map((x) => x.id), group: 'theme', title: t('theme'), run: (a) => setTheme(THEMES.find((x) => x.id === a.toLowerCase() || x.label.toLowerCase() === a.toLowerCase()) ?? theme) })
    add({ id: 'g:lang', slash: 'lang', args: 'en|ar', options: ['en', 'ar'], group: 'theme', title: t('language'), run: (a) => (a === 'en' || a === 'ar' ? setLang(a) : setLang(lang === 'en' ? 'ar' : 'en')) })
    for (const th of THEMES) if (th.id !== theme.id) add({ id: `g:theme:${th.id}`, group: 'theme', title: `${t('theme')}: ${th.label}`, run: () => setTheme(th) })
    return list
  }, [t, owner, setRoute, setTheme, theme, lang, setLang, sessions, providers.data, toast, setScopeAll, setNavOpen])
  useRegisterCommands('global', globals)

  // Keyboard: palette, new session, details panel.
  useEffect(() => {
    const on = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') (e.preventDefault(), setPalette((p) => !p))
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'o') (e.preventDefault(), setRoute({ page: 'home' }))
      else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') (e.preventDefault(), setRoute({ page: 'settings' }))
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [setRoute])
  useEffect(() => {
    const on = (): void => setHelp(true)
    window.addEventListener('vara:help', on)
    return () => window.removeEventListener('vara:help', on)
  }, [])

  if (meError && !me) {
    return (
      <div className="center-screen">
        <div className="card narrow">
          <p>{t('error')}: {meError}</p>
        </div>
      </div>
    )
  }
  if (!me) {
    return <div className="center-screen muted">{t('loading')}</div>
  }
  const toggle = (): void => setNavOpen(true)

  // Guests never see the team page, even by typing the URL.
  const page = route.page === 'team' && me.role !== 'owner' ? ({ page: 'home' } as Route) : route
  return (
    <div className="app">
      {me.role === 'owner' && me.host.update && !updateHidden ? (
        <div className="update-note" role="status">
          {t('upd_available', { v: me.host.update.latest, c: me.host.update.current })} <code>vara update</code>
          <button className="linklike" onClick={() => (setUpdateHidden(true), hideUpdate())}>
            {t('close')}
          </button>
        </div>
      ) : null}
      {me.role === 'owner' && me.share ? (
        <div className="share-banner" role="alert">
          <strong>{t('share_live')}</strong> <span dir="ltr">{me.share.url}</span>
          {me.share.expiresAt ? <span> · {t('share_until', { t: new Date(me.share.expiresAt).toLocaleTimeString() })}</span> : null}
          <span> — {t('share_risk')}</span>
        </div>
      ) : null}
      <Workbench
        sessions={sessions}
        route={page}
        onRoute={setRoute}
        navOpen={navOpen}
        sessionsLoaded={sessionsLoaded}
        folderName={(folder?.current ?? me.host.folder).split(/[\\/]/).filter(Boolean).pop() ?? ''}
        nav={({ openIds, onSplit }) => <Sidebar me={me} host={me.host} sessions={sessions} route={page} onRoute={setRoute} onSignOut={signOut} open={navOpen} onClose={() => setNavOpen(false)} onPalette={() => setPalette(true)} scopeAll={scopeAll} onScope={setScopeAll} openIds={openIds} onSplit={onSplit} {...(owner && folder ? { folder: folder.current, onFolder: () => (loadFolder(), setPickFolder(true)) } : {})} />}
        renderSession={(id, role) => <SessionPage key={id} id={id} role={role} me={me} models={models} onChanged={reloadSessions} onToggleSidebar={toggle} go={setRoute} />}
        page={
          <>
            {page.page === 'home' ? <Home me={me} models={models} sessions={sessions} commands={globals} go={setRoute} onOpen={(id) => (reloadSessions(), open(id))} onToggleSidebar={toggle} /> : null}
            {page.page === 'team' ? <Team models={models} onOpenSession={open} onToggleSidebar={toggle} /> : null}
            {page.page === 'settings' ? <Settings me={me} tab={page.tab ?? (owner ? 'models' : 'look')} onTab={(tab) => setRoute({ page: 'settings', tab })} theme={theme} onTheme={setTheme} onToggleSidebar={toggle} /> : null}
          </>
        }
      />
      {pickFolder && folder ? <FolderDialog info={folder} onClose={() => setPickFolder(false)} onChanged={() => (loadFolder(), reloadSessions(), setRoute({ page: 'home' }))} /> : null}
      {help ? <Help onClose={() => setHelp(false)} /> : null}
      {palette ? <Palette onClose={() => setPalette(false)} sessions={sessions} onOpen={open} /> : null}
    </div>
  )
}

