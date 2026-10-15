import { useLayoutEffect, useRef, useState } from 'react'
import { LoaderCircle, SendHorizontal } from 'lucide-react'

/** A text box for phones and long prompts. Drafts stay until the target confirms delivery. */
export default function Composer({
  enabled,
  visible,
  text,
  onChange,
  onSend,
}: {
  enabled: boolean
  visible: boolean
  text: string
  onChange: (text: string) => void
  onSend: (text: string) => Promise<void>
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const element = field.current!
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`
  }, [text, visible])
  async function submit() {
    if (!enabled || busy || !text) return
    setBusy(true)
    setError('')
    try {
      await onSend(text)
      onChange('')
    } catch (problem) {
      setError((problem as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="composer"
      hidden={!visible}
      onSubmit={event => {
        event.preventDefault()
        void submit()
      }}
    >
      <textarea
        ref={field}
        rows={1}
        value={text}
        placeholder="Type a message… (Ctrl+Enter sends)"
        aria-label="Message to the session"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        maxLength={16000}
        disabled={busy}
        onChange={event => {
          onChange(event.target.value)
          setError('')
        }}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void submit()
          }
        }}
      />
      <button className="button primary" disabled={!enabled || busy || !text} aria-label="Send">
        {busy ? <LoaderCircle className="spin" size={16} /> : <SendHorizontal size={16} />}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}
