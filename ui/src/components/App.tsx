import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api, auth, onUnauthorized } from '../api'
import { makeRegistry, RegistryContext, useRegisterCommands, type Cmd } from '../commands'
import { useMe, useSessions } from '../hooks'
import { LangContext, applyLang, savedLang, useT, type Lang } from '../i18n'
import { DEFAULT_PREFS, PrefsContext, savedPrefs, storePrefs, type Prefs } from '../prefs'
import { THEMES, applyTheme, savedTheme, type Theme } from '../theme'
import type { ModelsInfo } from '../types'
import { Team } from './Admin'
import { Home } from './Home'
import { FolderDialog, type FolderInfo } from './Folder'
import { Join, SignIn } from './Misc'
import { Palette } from './Palette'
import { SessionPage } from './SessionPage'
import { Settings, isTab } from './Settings'
import { Sidebar, type Route } from './Sidebar'
import { ToastHost } from './toast'

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

export function App() {
  const [lang, setLangState] = useState<Lang>(savedLang)
  const [theme, setTheme] = useState<Theme>(savedTheme)
  const [prefs, setPrefsState] = useState<Prefs>(() => (typeof localStorage === 'undefined' ? DEFAULT_PREFS : savedPrefs()))
  const [authed, setAuthed] = useState(() => !!auth.get())
  const [invite, setInvite] = useState<string | null>(boot.invite)
  const [route, setRouteState] = useState<Route>(() => parseRoute(location.hash))
  const [navOpen, setNavOpen] = useState(false)
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
  const { sessions, reload: reloadSessions } = useSessions(!!me)

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
  signOut: () => void
}) {
  const t = useT()
  const { lang, setLang } = useContext(LangContext)
  const [palette, setPalette] = useState(false)
  const [folder, setFolder] = useState<FolderInfo | null>(null)
  const [pickFolder, setPickFolder] = useState(false)
  const owner = me?.role === 'owner'
  const loadFolder = useCallback(() => {
    if (owner) api<FolderInfo>('GET', '/api/folder').then(setFolder).catch(() => {})
  }, [owner])
  useEffect(loadFolder, [loadFolder])
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
      add({ id: 'g:skills', slash: 'skills', group: 'settings', title: t('t_skills'), description: t('cmd_skillsHelp'), run: () => setRoute({ page: 'settings', tab: 'skills' }) })
      add({ id: 'g:mcp', slash: 'mcp', group: 'settings', title: t('t_mcp'), description: t('cmd_mcpHelp'), run: () => setRoute({ page: 'settings', tab: 'mcp' }) })
    }
    add({ id: 'g:settings', slash: 'settings', group: 'settings', title: t('settings'), run: () => setRoute({ page: 'settings' }) })
    add({ id: 'g:theme', slash: 'theme', args: '<name>', options: THEMES.map((x) => x.id), group: 'theme', title: t('theme'), run: (a) => setTheme(THEMES.find((x) => x.id === a.toLowerCase() || x.label.toLowerCase() === a.toLowerCase()) ?? theme) })
    add({ id: 'g:lang', slash: 'lang', args: 'en|ar', options: ['en', 'ar'], group: 'theme', title: t('language'), run: (a) => (a === 'en' || a === 'ar' ? setLang(a) : setLang(lang === 'en' ? 'ar' : 'en')) })
    for (const th of THEMES) if (th.id !== theme.id) add({ id: `g:theme:${th.id}`, group: 'theme', title: `${t('theme')}: ${th.label}`, run: () => setTheme(th) })
    return list
  }, [t, owner, setRoute, setTheme, theme, lang, setLang])
  useRegisterCommands('global', globals)

  // Keyboard: palette, new session, details panel.
  useEffect(() => {
    const on = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') (e.preventDefault(), setPalette((p) => !p))
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'o') (e.preventDefault(), setRoute({ page: 'home' }))
      else if (mod && e.key === '.') (e.preventDefault(), window.dispatchEvent(new Event('vara:panel')))
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [setRoute])

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
      {me.role === 'owner' && me.share ? (
        <div className="share-banner" role="alert">
          <strong>{t('share_live')}</strong> <span dir="ltr">{me.share.url}</span>
          {me.share.expiresAt ? <span> · {t('share_until', { t: new Date(me.share.expiresAt).toLocaleTimeString() })}</span> : null}
          <span> — {t('share_risk')}</span>
        </div>
      ) : null}
      <Sidebar me={me} host={me.host} sessions={sessions} route={page} onRoute={setRoute} onSignOut={signOut} open={navOpen} onClose={() => setNavOpen(false)} onPalette={() => setPalette(true)} {...(owner && folder ? { folder: folder.current, onFolder: () => (loadFolder(), setPickFolder(true)) } : {})} />
      {page.page === 'home' ? <Home me={me} models={models} sessions={sessions} commands={globals} go={setRoute} onOpen={(id) => (reloadSessions(), open(id))} onToggleSidebar={toggle} /> : null}
      {page.page === 'session' ? <SessionPage key={page.id} id={page.id} me={me} models={models} onChanged={reloadSessions} onToggleSidebar={toggle} go={setRoute} /> : null}
      {page.page === 'team' ? <Team models={models} onOpenSession={open} onToggleSidebar={toggle} /> : null}
      {page.page === 'settings' ? <Settings me={me} tab={page.tab ?? (owner ? 'models' : 'look')} onTab={(tab) => setRoute({ page: 'settings', tab })} theme={theme} onTheme={setTheme} onToggleSidebar={toggle} /> : null}
      {pickFolder && folder ? <FolderDialog info={folder} onClose={() => setPickFolder(false)} onChanged={() => (loadFolder(), reloadSessions(), setRoute({ page: 'home' }))} /> : null}
      {palette ? <Palette onClose={() => setPalette(false)} sessions={sessions} onOpen={open} /> : null}
    </div>
  )
}

