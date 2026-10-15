import { useState } from 'react'
import { buildItems, toolSummary, type ChatItem } from '../transcript'
import { useT } from '../i18n'
import { usePrefs } from '../prefs'
import type { SessionView } from '../types'
import { countStatus, runStatus, type SwarmRunModel } from '../swarm-model'
import { AgentStatusIcon, costText } from './AgentsPanel'
import { Badge, Icon } from './ui'
import { Markdown } from './Markdown'
import { AttachedImage } from './Attached'

const TOOL_ICON: Record<string, string> = {
  read_file: 'file',
  write_file: 'file',
  edit_file: 'file',
  delete_file: 'trash',
  list_dir: 'file',
  glob: 'search',
  grep: 'search',
  shell: 'terminal',
  delegate: 'branch',
  skill: 'spark',
  escalate: 'spark',
  ask_user: 'alert',
  complete: 'check',
}

function ToolCard({ item, running }: { item: Extract<ChatItem, { kind: 'tool' }>; running: boolean }) {
  const { prefs } = usePrefs()
  const [open, setOpen] = useState(false)
  const status = item.ok === undefined ? (running ? 'running' : 'pending') : item.ok ? 'ok' : 'fail'
  let args = item.args
  try {
    args = JSON.stringify(JSON.parse(item.args), null, 2)
  } catch {
    /* show raw */
  }
  return (
    <div className={`tool tool-${status}`}>
      <button className="tool-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon name="chevron" size={14} className={`chev${open ? ' open' : ''}`} />
        <Icon name={TOOL_ICON[item.name] ?? 'terminal'} size={15} />
        <span className="tool-name">{item.name}</span>
        <span className="tool-sum" dir="auto">
          {prefs.toolDetails ? toolSummary({ name: item.name, arguments: item.args }) : ''}
        </span>
        <span className="tool-status" aria-label={status}>
          {status === 'running' ? <span className="pulse" /> : status === 'ok' ? <Icon name="check" size={14} /> : status === 'fail' ? <Icon name="x" size={14} /> : null}
        </span>
      </button>
      {open ? (
        <div className="tool-body" dir="ltr">
          <pre>{args}</pre>
          {item.output !== undefined ? <pre className="tool-out">{item.output.length > 6000 ? `${item.output.slice(0, 6000)}\n… (${item.output.length - 6000} more characters)` : item.output}</pre> : null}
        </div>
      ) : null}
    </div>
  )
}

/** A delegate call, drawn as what it is: a small team, with live status per agent. */
function SwarmInline({ run, onOpen }: { run: SwarmRunModel; onOpen: () => void }) {
  const t = useT()
  const c = countStatus(run)
  const st = runStatus(run)
  const cost = costText(run, t('unknown'))
  return (
    <section className={`swarm-inline run-${st}`} aria-label={t('ag_title')}>
      <header>
        <Icon name="branch" size={15} />
        <strong>{t('ag_title')}</strong>
        <span className="muted small num">{t('ag_progress', { done: c.done + c.failed + c.skipped, total: run.agents.length })}</span>
        {run.modelCalls !== undefined ? <span className="muted small num">{run.modelCalls} {t('calls')}{cost ? ` · ${cost}` : ''}</span> : null}
        <button className="linklike" onClick={onOpen}>{t('ag_open')}</button>
      </header>
      {run.rejected ? <div className="inline-error" role="alert">{t('ag_rejected')}: {run.rejected}</div> : null}
      <ul>
        {run.agents.map((a) => (
          <li key={a.id} className={`st-${a.status}`}>
            <span className="agent-mark"><AgentStatusIcon status={a.status} size={13} /></span>
            <span className="agent-title clip" dir="auto">{a.title}</span>
            {a.role ? <span className="chip" dir="ltr">{a.role}</span> : null}
            {a.dependsOn.length ? <span className="muted small" dir="ltr">← {a.dependsOn.join(', ')}</span> : null}
            <span className="muted small agent-now" dir="auto">{a.status === 'running' ? a.detail ?? t('ag_running') : a.status === 'skipped' ? a.detail ?? t('sw_skipped') : a.status === 'waiting' ? t('sw_waiting') : ''}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function Chat({
  view,
  stream,
  thinking,
  activeTool,
  swarm,
  onOpenAgents,
  isOwner,
}: {
  view: SessionView
  stream: string
  thinking: string
  activeTool: string | null
  swarm: SwarmRunModel[]
  onOpenAgents: () => void
  isOwner: boolean
}) {
  const t = useT()
  const { prefs } = usePrefs()
  const items = buildItems(view)
  const lastToolIndex = items.map((i) => i.kind).lastIndexOf('tool')
  const running = view.state === 'running'
  return (
    <div className="chat">
      {items.map((item, i) => {
        if (item.kind === 'user') {
          return (
            <div className="msg msg-user" key={i}>
              {item.author ? <div className="msg-author">{item.author}</div> : null}
              <div className="bubble" dir="auto">
                {item.text}
                {item.images?.length || item.files?.length ? (
                  <div className="attached">
                    {item.images?.map((im) => <AttachedImage key={im.id} sessionId={view.id} file={im.id} name={im.name} />)}
                    {item.files?.map((f) => (
                      <span className="chip" key={f}>
                        <Icon name="file" size={12} /> {f}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          )
        }
        if (item.kind === 'assistant') {
          return (
            <div className="msg msg-assistant" key={i}>
              <div className="avatar" aria-hidden="true">
                V
              </div>
              <Markdown text={item.text} />
            </div>
          )
        }
        const run = item.name === 'delegate' ? swarm.find((r) => r.key === item.id) : undefined
        if (run) return <SwarmInline key={item.id} run={run} onOpen={onOpenAgents} />
        return <ToolCard key={item.id} item={item} running={running && (i === lastToolIndex || activeTool === item.name)} />
      })}

      {swarm.filter((r) => r.live && !items.some((i) => i.kind === 'tool' && i.id === r.key)).map((r) => (
        <SwarmInline key={r.key} run={r} onOpen={onOpenAgents} />
      ))}

      {isOwner && prefs.showThinking && thinking && running ? (
        <details className="thinking">
          <summary>
            <span className="pulse" /> {t('thinking')}
          </summary>
          <p dir="auto">{thinking}</p>
        </details>
      ) : null}

      {stream ? (
        <div className="msg msg-assistant">
          <div className="avatar" aria-hidden="true">
            V
          </div>
          <Markdown text={stream} />
        </div>
      ) : running && !activeTool ? (
        <div className="msg msg-assistant typing" aria-label={t('working')}>
          <div className="avatar" aria-hidden="true">
            V
          </div>
          <span className="dots">
            <i />
            <i />
            <i />
          </span>
        </div>
      ) : null}

      {view.stateReason && ['waiting_user', 'paused', 'failed', 'interrupted'].includes(view.state) ? (
        <div className="notice">
          <Badge tone={view.state === 'failed' ? 'err' : 'warn'}>{t(`state_${view.state}` as 'state_idle')}</Badge> <span dir="auto">{view.stateReason}</span>
        </div>
      ) : null}
    </div>
  )
}
