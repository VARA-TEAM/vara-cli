import { useState } from 'react'
import { buildItems, toolSummary, type ChatItem } from '../transcript'
import { useT } from '../i18n'
import { usePrefs } from '../prefs'
import type { SessionView } from '../types'
import type { SubagentRow } from '../hooks'
import { Badge, Icon } from './ui'
import { Markdown } from './Markdown'

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

export function Chat({
  view,
  stream,
  thinking,
  activeTool,
  subagents,
  isOwner,
}: {
  view: SessionView
  stream: string
  thinking: string
  activeTool: string | null
  subagents: SubagentRow[]
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
        return <ToolCard key={item.id} item={item} running={running && (i === lastToolIndex || activeTool === item.name)} />
      })}

      {subagents.length ? (
        <div className="subagents">
          {subagents.map((s) => (
            <div key={s.id} className={`subagent sub-${s.status}`}>
              <Icon name="branch" size={14} />
              <span dir="auto">{s.title}</span>
              {s.status === 'running' ? <span className="pulse" /> : s.status === 'done' ? <Icon name="check" size={14} /> : <Icon name="x" size={14} />}
              {s.detail && s.status === 'running' ? <span className="muted">{s.detail}</span> : null}
            </div>
          ))}
        </div>
      ) : null}

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
