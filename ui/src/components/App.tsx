import { useCallback, useEffect, useState } from 'react'
import { api, auth, onUnauthorized } from '../api'
import { useMe, useSessions } from '../hooks'
import { LangContext, applyLang, savedLang, useT, type Lang } from '../i18n'
import { applyTheme, savedTheme, type Theme } from '../theme'
import type { ModelsInfo } from '../types'
import { Team } from './Admin'
import { Home } from './Home'
import { Join, Settings, SignIn } from './Misc'
import { SessionPage } from './SessionPage'
import { Sidebar, type Route } from './Sidebar'

/** `#/s/<id>`, `#/team`, `#/settings`, anything else = home. */
export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, '')
  const s = /^\/s\/([\w-]+)$/.exec(h)
  if (s) return { page: 'session', id: s[1]! }
  if (h === '/team') return { page: 'team' }
  if (h === '/settings') return { page: 'settings' }
  return { page: 'home' }
}
export function routeToHash(r: Route): string {
  return r.page === 'session' ? `#/s/${r.id}` : r.page === 'team' ? '#/team' : r.page === 'settings' ? '#/settings' : '#/'
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
  const [authed, setAuthed] = useState(() => !!auth.get())
  const [invite, setInvite] = useState<string | null>(boot.invite)
  const [route, setRouteState] = useState<Route>(() => parseRoute(location.hash))
  const [navOpen, setNavOpen] = useState(false)
  const [models, setModels] = useState<ModelsInfo | null>(null)

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
  const open = (id: string): void => setRoute({ page: 'session', id })

  // Guests never see the team page, even by typing the URL.
  const page = route.page === 'team' && me.role !== 'owner' ? ({ page: 'home' } as Route) : route
  return (
    <div className="app">
      <Sidebar me={me} host={me.host} sessions={sessions} route={page} onRoute={setRoute} onSignOut={signOut} open={navOpen} onClose={() => setNavOpen(false)} />
      {page.page === 'home' ? <Home me={me} models={models} sessions={sessions} onOpen={(id) => (reloadSessions(), open(id))} onToggleSidebar={toggle} /> : null}
      {page.page === 'session' ? <SessionPage key={page.id} id={page.id} me={me} models={models} onChanged={reloadSessions} onToggleSidebar={toggle} /> : null}
      {page.page === 'team' ? <Team models={models} onOpenSession={open} onToggleSidebar={toggle} /> : null}
      {page.page === 'settings' ? <Settings me={me} theme={theme} onTheme={setTheme} onToggleSidebar={toggle} /> : null}
    </div>
  )
}
