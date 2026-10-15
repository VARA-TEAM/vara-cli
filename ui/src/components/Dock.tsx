import { useEffect, useMemo, useRef, useState } from 'react'
import type { LiveEvent } from '../hooks'
import { useStickToBottom } from '../hooks'
import { useT, type Key } from '../i18n'
import { DOCK_TABS, type DockTab } from '../layout'
import { buildItems, toolSummary } from '../transcript'
import type { SessionView } from '../types'
import { Preview } from './Preview'
import { CopyButton, Icon } from './ui'

const TAB_LABEL: Record<DockTab, Key> = { output: 'dock_output', preview: 'tab_preview', events: 'dock_events' }

function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

/** Terminal-like feed of what the agent ran and what came back, newest at the bottom. `/last` jumps to the last call. */
function Output({ view, activeTool, focusLast }: { view: SessionView; activeTool: string | null; focusLast: number }) {
  const t = useT()
  const [shellOnly, setShellOnly] = useState(false)
  const items = useMemo(() => buildItems(view).filter((i): i is Extract<ReturnType<typeof buildItems>[number], { kind: 'tool' }> => i.kind === 'tool'), [view])
  const shown = (shellOnly ? items.filter((i) => i.name === 'shell') : items).slice(-80)
  const last = items.length ? items[items.length - 1]!.id : null
  const scroll = useStickToBottom<HTMLDivElement>(`${shown.length}:${shown[shown.length - 1]?.output?.length ?? 0}`)
  const lastRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focusLast) lastRef.current?.scrollIntoView({ block: 'center' })
  }, [focusLast])
  return (
    <>
      <div className="dock-tools">
        <label className="check small">
          <input type="checkbox" checked={shellOnly} onChange={(e) => setShellOnly(e.target.checked)} /> {t('dock_shellOnly')}
        </label>
        {activeTool ? (
          <span className="muted small dock-live">
            <span className="pulse" aria-hidden="true" /> {activeTool}
          </span>
        ) : null}
      </div>
      <div className="dock-scroll term" ref={scroll.ref} tabIndex={0} role="log" aria-label={t('dock_output')}>
        {shown.length === 0 ? <p className="muted pad">{t('dock_outputEmpty')}</p> : null}
        {shown.map((i) => (
          <div key={i.id} ref={i.id === last ? lastRef : undefined} className={`term-call${i.ok === false ? ' bad' : ''}${i.id === last && focusLast ? ' flash' : ''}`}>
            <div className="term-head" dir="ltr">
              <span className="term-prompt">{i.name === 'shell' ? '$' : '›'}</span>
              <span className="term-cmd">{i.name === 'shell' ? toolSummary({ name: i.name, arguments: i.args }).replace(/^\$ /, '') : `${i.name} ${toolSummary({ name: i.name, arguments: i.args })}`}</span>
              <span className="term-state">{i.output === undefined ? <span className="pulse" aria-label={t('working')} /> : i.ok ? <Icon name="check" size={13} /> : <Icon name="x" size={13} />}</span>
            </div>
            {i.output !== undefined ? <pre className="term-out" dir="ltr">{i.output.length > 12000 ? `${i.output.slice(0, 12000)}\n… (${i.output.length - 12000} more characters)` : i.output}</pre> : null}
          </div>
        ))}
      </div>
    </>
  )
}

function Events({ events }: { events: LiveEvent[] }) {
  const t = useT()
  const scroll = useStickToBottom<HTMLDivElement>(events.length)
  const text = events.map((e) => `${clock(e.at)} ${e.type} ${e.text}`).join('\n')
  return (
    <>
      <div className="dock-tools">
        <span className="muted small">{t('dock_eventsNote')}</span>
        <span className="spacer" />
        {events.length ? <CopyButton text={text} /> : null}
      </div>
      <div className="dock-scroll term" ref={scroll.ref} tabIndex={0} role="log" aria-label={t('dock_events')}>
        {events.length === 0 ? <p className="muted pad">{t('dock_eventsEmpty')}</p> : null}
        {events.map((e, i) => (
          <div key={i} className={`ev-line ev-${e.type}`} dir="ltr">
            <span className="muted">{clock(e.at)}</span>
            <span className="ev-type">{e.type}</span>
            <span className="ev-text">{e.text}</span>
          </div>
        ))}
      </div>
    </>
  )
}

/** The bottom dock: output, the app preview, and the live event log. */
export function Dock({
  view,
  events,
  activeTool,
  owner,
  tab,
  onTab,
  onClose,
  focusLast,
}: {
  view: SessionView
  events: LiveEvent[]
  activeTool: string | null
  owner: boolean
  tab: DockTab
  onTab: (t: DockTab) => void
  onClose: () => void
  focusLast: number
}) {
  const t = useT()
  const tabs = DOCK_TABS.filter((x) => x !== 'preview' || owner)
  const cur = tabs.includes(tab) ? tab : 'output'
  const onKey = (e: React.KeyboardEvent): void => {
    const i = tabs.indexOf(cur)
    const rtl = document.documentElement.dir === 'rtl'
    const d = e.key === 'ArrowRight' ? (rtl ? -1 : 1) : e.key === 'ArrowLeft' ? (rtl ? 1 : -1) : 0
    if (d) (e.preventDefault(), onTab(tabs[(i + d + tabs.length) % tabs.length]!))
  }
  return (
    <section className="dock" aria-label={t('wb_dock')}>
      <div className="dock-head">
        <div className="dock-tabs" role="tablist" aria-label={t('wb_dock')} onKeyDown={onKey}>
          {tabs.map((id) => (
            <button key={id} role="tab" id={`dock-tab-${id}`} aria-controls={`dock-pane-${id}`} aria-selected={cur === id} tabIndex={cur === id ? 0 : -1} className={cur === id ? 'on' : ''} onClick={() => onTab(id)}>
              {t(TAB_LABEL[id])}
            </button>
          ))}
        </div>
        <button className="icon-btn" onClick={onClose} aria-label={t('close')} title={t('close')}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="dock-body" role="tabpanel" id={`dock-pane-${cur}`} aria-labelledby={`dock-tab-${cur}`}>
        {cur === 'output' ? <Output view={view} activeTool={activeTool} focusLast={focusLast} /> : null}
        {cur === 'preview' && owner ? (
          <div className="dock-scroll">
            <Preview sessionId={view.id} />
          </div>
        ) : null}
        {cur === 'events' ? <Events events={events} /> : null}
      </div>
    </section>
  )
}
