import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Bell,
  BellOff,
  BellRing,
  ImagePlus,
  Keyboard,
  LoaderCircle,
  MessageSquareText,
  PanelTopClose,
  PanelTopOpen,
  RotateCw,
  Search,
  X,
} from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import type { SessionActivity } from '../../shared/activity'
import type { CloseReason } from '../../shared/protocol'
import type { LocalTerminalBridge } from '../../shared/localTerminal'
import { imageMediaTypes } from '../../shared/images'
import { openBrowserTab } from './browser'
import { screenText } from './clipboard'
import Composer from './Composer'
import KeyBar from './KeyBar'
import TerminalContextMenu from './TerminalContextMenu'
import TerminalTextDialog from './TerminalTextDialog'
import TerminalSearch from './TerminalSearch'
import { useTerminalSearch } from './useTerminalSearch'
import { touchInput as touch } from '../browser'
import { useTerminalViewport } from './viewport'
import type { TerminalModifiers } from './keys'
import type { TerminalState } from './connection'
import { TerminalSession } from './session'
import { desktop } from '../desktop'
import { notificationLabels, useBellNotifications } from './useBellNotifications'

const closedTitles: Record<CloseReason, string> = {
  ended: 'Session ended',
  expired: 'Connection expired',
  outdated: 'Update required',
  unavailable: 'Connection unavailable',
  error: 'Disconnected',
}

type Props = {
  title: string
  onClose: () => void
  onResume?: (token: string, title: string) => void | Promise<void>
} & ({ token: string; local?: never } | { token?: never; local: LocalTerminalBridge })

const toolbarPreference = 'outpost.terminal.toolbar-hidden'
function savedToolbar() {
  try {
    const stored = localStorage.getItem(toolbarPreference)
    return stored === null ? !desktop : stored !== 'true'
  } catch {
    return true
  }
}

export default function TerminalView({ token, local, title, onClose, onResume }: Props) {
  const container = useRef<HTMLDivElement>(null)
  useTerminalViewport(container)
  const surface = useRef<HTMLDivElement>(null),
    recovery = useRef<HTMLDivElement>(null),
    chooser = useRef<HTMLInputElement>(null)
  const session = useRef<TerminalSession | null>(null)
  const [state, setState] = useState<TerminalState>({ kind: 'connecting' })
  const [mountAttempt, setMountAttempt] = useState(0)
  const [activity, setActivity] = useState<SessionActivity | null>(null)
  const [name, setName] = useState(title)
  const [bellRinging, setBellRinging] = useState(false)
  const [status, setStatus] = useState('')
  const [blockedLink, setBlockedLink] = useState<string | null>(null)
  const [keysShown, setKeysShown] = useState(touch)
  const [composerShown, setComposerShown] = useState(touch)
  const [draft, setDraft] = useState('')
  const [textToSelect, setTextToSelect] = useState<string | null>(null)
  const hasDraft = draft.length > 0
  const [modifiers, setModifiers] = useState<TerminalModifiers>({})
  const statusTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const connected = state.kind === 'connected'
  const [toolbarShown, setToolbarShown] = useState(savedToolbar)
  const lifecycle = useRef({ onResume, title })
  useEffect(() => {
    lifecycle.current = { onResume, title }
  }, [onResume, title])
  const showToolbar = (shown: boolean) => {
    setToolbarShown(shown)
    try {
      localStorage.setItem(toolbarPreference, String(!shown))
    } catch {
      /* The layout preference is optional. */
    }
    if (!touch()) session.current?.terminal.focus()
  }

  const focusRecovery = useCallback(() => {
    const panel = recovery.current
    if (!panel) return false
    if (!panel.contains(document.activeElement)) panel.querySelector('button')?.focus({ preventScroll: true })
    return true
  }, [])
  const restoreTerminalFocus = useCallback(() => {
    if (!focusRecovery()) session.current?.terminal.focus()
  }, [focusRecovery])
  const search = useTerminalSearch(restoreTerminalFocus)
  const { attach: attachSearch, open: openSearch, screenCleared } = search

  useLayoutEffect(() => {
    if (state.kind !== 'closed' || !document.hasFocus() || (desktop && session.current && !session.current.focused))
      return
    // Inert removes focus from xterm. Give keyboard users a recovery action,
    // while preserving any toolbar, message-box, or dialog control they are using.
    const active = document.activeElement
    if (active === document.body || surface.current?.contains(active)) focusRecovery()
  }, [state.kind, focusRecovery])

  useEffect(() => {
    const previous = document.title
    document.title = bellRinging ? `🔔 ${name} rang a bell · Outpost` : `${name} · Outpost`
    return () => {
      document.title = previous
    }
  }, [name, bellRinging])

  useEffect(() => {
    void desktop
      ?.reportState({ title: name, connection: state.kind, activity, attention: bellRinging, hasDraft })
      .catch(() => {})
  }, [name, state.kind, activity, bellRinging, hasDraft])

  const notify = useCallback((message: string, sticky = false) => {
    setStatus(message)
    clearTimeout(statusTimer.current)
    if (!sticky) statusTimer.current = setTimeout(() => setStatus(''), 4000)
  }, [])
  const notifications = useBellNotifications(notify)
  const selectText = () => {
    if (!session.current) return
    setTextToSelect(screenText(session.current.terminal))
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  }
  const pasteImage = (file: File) => session.current?.pasteImage(file)

  useEffect(() => () => clearTimeout(statusTimer.current), [])

  useEffect(() => {
    let current: TerminalSession
    try {
      current = new TerminalSession({
        surface: surface.current!,
        container: container.current!,
        title: lifecycle.current.title,
        source: local ? { kind: 'local', bridge: local } : { kind: 'remote', token: token! },
        state: setState,
        activity: setActivity,
        titleChanged: setName,
        bellChanged: setBellRinging,
        modifiersChanged: setModifiers,
        notice: notify,
        blockedLink: setBlockedLink,
        showComposer: () => setComposerShown(true),
        focusRecovery,
        attachSearch,
        openSearch,
        screenCleared,
        resume: (token, title) => lifecycle.current.onResume?.(token, title),
      })
    } catch (error) {
      // A discarded StrictMode mount must not publish a stale initialization failure.
      const failure = setTimeout(
        () =>
          setState({
            kind: 'closed',
            reason: 'error',
            message: `Could not start the terminal: ${(error as Error).message}`,
          }),
        0,
      )
      return () => clearTimeout(failure)
    }
    session.current = current
    return () => {
      session.current = null
      current.dispose()
    }
  }, [token, local, mountAttempt, notify, focusRecovery, attachSearch, openSearch, screenCleared])

  const send = async (text: string) => {
    if (!session.current) throw new Error('The terminal is not available. Your draft is kept.')
    await session.current.submit(text)
  }
  const label =
    state.kind === 'connected'
      ? 'Connected'
      : state.kind === 'connecting'
        ? 'Connecting…'
        : state.kind === 'reconnecting'
          ? `Reconnecting… (${state.attempt})`
          : 'Disconnected'

  return (
    <div ref={container} className="terminal-view" role="dialog" aria-label={`Terminal · ${name}`}>
      <header className="terminal-bar" hidden={!toolbarShown}>
        <div className="terminal-title">
          <strong>{name}</strong>
          <span className={`terminal-state ${state.kind}`} role="status" aria-label={label}>
            {state.kind === 'connecting' || state.kind === 'reconnecting' ? (
              <LoaderCircle className="spin" size={12} />
            ) : (
              <i />
            )}
            <span className="terminal-state-label">{label}</span>
          </span>
        </div>
        <div className="terminal-actions">
          <button
            className="icon-button terminal-find"
            title="Find in terminal"
            aria-label="Find in terminal"
            disabled={state.kind === 'closed'}
            onClick={openSearch}
          >
            <Search size={17} />
          </button>
          <button
            className="icon-button"
            title="Hide terminal toolbar"
            aria-label="Hide terminal toolbar"
            onClick={() => showToolbar(false)}
          >
            <PanelTopClose size={17} />
          </button>
          <button
            className="icon-button"
            title={notificationLabels[notifications.permission]}
            aria-label={notificationLabels[notifications.permission]}
            disabled={notifications.requesting}
            onClick={notifications.request}
          >
            {notifications.requesting ? (
              <LoaderCircle className="spin" size={17} />
            ) : notifications.permission === 'granted' ? (
              <BellRing size={17} />
            ) : notifications.permission === 'default' ? (
              <Bell size={17} />
            ) : (
              <BellOff size={17} />
            )}
          </button>
          <input
            ref={chooser}
            type="file"
            hidden
            accept={imageMediaTypes.join(',')}
            onChange={event => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void pasteImage(file)
            }}
          />
          <button
            className="icon-button"
            title="Paste an image"
            aria-label="Paste an image"
            disabled={!connected}
            onClick={() => chooser.current?.click()}
          >
            <ImagePlus size={17} />
          </button>
          <button
            className="icon-button"
            title="On-screen keys"
            aria-label="On-screen keys"
            aria-pressed={keysShown}
            onClick={() => setKeysShown(!keysShown)}
          >
            <Keyboard size={17} />
          </button>
          <button
            className="icon-button"
            title="Message box"
            aria-label="Message box"
            aria-pressed={composerShown}
            onClick={() => setComposerShown(!composerShown)}
          >
            <MessageSquareText size={17} />
          </button>
          <button
            className="icon-button"
            title={local ? 'Close terminal and end the local shell' : 'Close terminal (the session keeps running)'}
            aria-label="Close terminal"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
      </header>
      {!toolbarShown && (
        <button
          className="icon-button terminal-show-toolbar"
          title="Show terminal toolbar"
          aria-label="Show terminal toolbar"
          onClick={() => showToolbar(true)}
        >
          <PanelTopOpen size={17} />
        </button>
      )}
      <div className="terminal-body">
        <TerminalContextMenu
          connected={connected}
          actions={{
            canCopy: () => session.current?.clipboard.canCopy() ?? false,
            copy: () => void session.current?.clipboard.copy(),
            paste: () => void session.current?.clipboard.paste(),
            selectAll: () => session.current?.terminal.selectAll(),
            selectText,
            find: openSearch,
            clear: () => session.current?.clearScreen(),
            pasteImage: () => chooser.current?.click(),
            focus: () => {
              if (!touch()) session.current?.terminal.focus()
            },
          }}
          controls={[
            { label: 'Terminal toolbar', shown: toolbarShown, onChange: showToolbar },
            { label: 'Message box', shown: composerShown, onChange: setComposerShown },
            { label: 'On-screen keys', shown: keysShown, onChange: setKeysShown },
          ]}
        >
          <div className="terminal-surface" ref={surface} inert={state.kind === 'closed'} />
        </TerminalContextMenu>
        {search.visible && state.kind !== 'closed' && <TerminalSearch search={search} />}
        {/* Notices float over the screen; they must never change PTY geometry. */}
        <div className={`terminal-notices${toolbarShown ? '' : ' toolbar-hidden'}`}>
          {(status || (!toolbarShown && (state.kind === 'connecting' || state.kind === 'reconnecting'))) && (
            <div className="terminal-notice" role="status">
              <span>{status || label}</span>
              {status && (
                <button className="icon-button" aria-label="Dismiss notice" onClick={() => setStatus('')}>
                  <X size={16} />
                </button>
              )}
            </div>
          )}
          {blockedLink && (
            <div className="terminal-notice terminal-notice-link">
              <span>
                The session wants to open <code>{blockedLink}</code>
              </span>
              <button
                className="button small primary"
                onClick={() => {
                  void openBrowserTab(blockedLink).then(opened => {
                    if (opened) setBlockedLink(null)
                    else
                      notify(
                        desktop
                          ? 'Could not open your default browser. Copy the link and open it in your browser.'
                          : 'Allow pop-ups for Outpost, then try again, or copy the link into your browser.',
                        true,
                      )
                  })
                }}
              >
                Open link
              </button>
              <button className="button small" onClick={() => setBlockedLink(null)}>
                Dismiss
              </button>
            </div>
          )}
          {bellRinging && (
            <div className="terminal-notice terminal-bell" role="status">
              <Bell size={16} aria-hidden="true" />
              <span>{name} rang a bell</span>
              <button
                className="icon-button"
                aria-label="Dismiss bell notification"
                onClick={() => session.current?.bells.acknowledge()}
              >
                <X size={16} />
              </button>
            </div>
          )}
        </div>
        {state.kind === 'closed' && (
          <div className="terminal-closed" ref={recovery}>
            <h3>{closedTitles[state.reason]}</h3>
            <p>{state.message}</p>
            <div>
              {state.reason === 'outdated' ? (
                <button className="button primary" onClick={() => window.location.reload()}>
                  <RotateCw size={15} />
                  Reload
                </button>
              ) : (
                state.reason !== 'expired' && (
                  <button
                    className="button primary"
                    onClick={() => {
                      if (session.current) session.current.connection.reconnect()
                      else setMountAttempt(attempt => attempt + 1)
                    }}
                  >
                    <RotateCw size={15} />
                    {local ? 'Start new shell' : 'Reconnect'}
                  </button>
                )
              )}
              <button className="button" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        )}
      </div>
      {keysShown && (
        <KeyBar
          enabled={connected}
          modifiers={modifiers}
          onModifiers={next => {
            session.current?.setModifiers(next)
            if (!touch()) session.current?.terminal.focus()
          }}
          onKey={(key, extra) => session.current?.press(key, extra)}
          onCopy={() => {
            if (touch() && !session.current?.clipboard.canCopy()) selectText()
            else void session.current?.clipboard.copy()
          }}
          onPaste={() => void session.current?.clipboard.paste()}
          onSelectText={selectText}
          onKeyboard={() => {
            const active = document.activeElement
            if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) active.blur()
            else session.current?.terminal.focus()
          }}
        />
      )}
      <Composer
        enabled={connected}
        visible={composerShown}
        text={draft}
        onChange={setDraft}
        onSend={send}
        onError={message => notify(message, true)}
      />
      {textToSelect !== null && <TerminalTextDialog text={textToSelect} onClose={() => setTextToSelect(null)} />}
    </div>
  )
}
