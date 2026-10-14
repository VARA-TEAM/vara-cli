import { useEffect, useRef, useState } from 'react'
import { useT } from '../i18n'
import { Button, Icon } from './ui'

/**
 * The message box. Enter sends, Shift+Enter adds a line (and never while an IME is composing,
 * which matters for Arabic/CJK input). Grows with its content, up to a limit.
 */
export function Composer({
  onSend,
  disabled,
  busy,
  placeholder,
  onPause,
  canPause,
  controls,
  autoFocus,
  big,
}: {
  onSend: (text: string) => Promise<void> | void
  disabled?: boolean
  busy?: boolean
  placeholder?: string
  onPause?: () => void
  canPause?: boolean
  controls?: React.ReactNode
  autoFocus?: boolean
  big?: boolean
}) {
  const t = useT()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, big ? 280 : 200)}px`
  }, [text, big])

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  const submit = async (): Promise<void> => {
    const value = text.trim()
    if (!value || disabled || sending) return
    setSending(true)
    try {
      await onSend(value)
      setText('')
    } finally {
      setSending(false)
      ref.current?.focus()
    }
  }

  return (
    <div className={`composer${disabled ? ' is-disabled' : ''}${big ? ' composer-big' : ''}`}>
      <textarea
        ref={ref}
        value={text}
        rows={big ? 3 : 1}
        dir="auto"
        disabled={disabled}
        placeholder={placeholder ?? t('placeholder')}
        aria-label={placeholder ?? t('placeholder')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void submit()
          }
        }}
      />
      <div className="composer-bar">
        <div className="composer-controls">{controls}</div>
        <div className="composer-actions">
          {busy && canPause && onPause ? (
            <Button kind="ghost" icon="pause" onClick={onPause} title={t('pause')}>
              {t('pause')}
            </Button>
          ) : null}
          <button className="send" onClick={() => void submit()} disabled={disabled || sending || !text.trim()} aria-label={t('send')} title={t('send')}>
            <Icon name="send" size={18} />
          </button>
        </div>
      </div>
    </div>
  )
}
