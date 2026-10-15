import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
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
  X,
} from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import type { ImageMediaType } from '../../shared/model'
import type { TerminalHostState } from '../../shared/desktop'
import type { SessionActivity } from '../../shared/activity'
import type { CloseReason } from '../../shared/protocol'
import { imageMediaTypes } from '../../shared/model'
import { browserUrl } from '../../shared/signals'
import { readImage } from '../api'
import { attachBell } from './bell'
import { TerminalActivity } from './activity'
import { openBrowserTab } from './browser'
import { attachClipboard, imageProblem } from './clipboard'
import Composer from './Composer'
import KeyBar from './KeyBar'
import TerminalContextMenu from './TerminalContextMenu'
import { terminalKey, type TerminalModifiers } from './keys'
import { TerminalSocket, type SocketState } from './socket'
import { desktop } from '../desktop'
import { notificationLabels, useBellNotifications } from './useBellNotifications'

const touch = () => window.matchMedia('(pointer: coarse)').matches
const closedTitles: Record<CloseReason, string> = {
  detached: 'Detached',
  ended: 'Session ended',
  expired: 'Connection expired',
  outdated: 'Update required',
  error: 'Disconnected',
}
const theme = {
  background: '#0f172a',
  foreground: '#e2e8f0',
  cursor: '#93c5fd',
  cursorAccent: '#0f172a',
  selectionBackground: '#334155',
  black: '#1e293b',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e2e8f0',
  brightBlack: '#64748b',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde68a',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#f8fafc',
}

interface Props {
  token: string
  title: string
  onClose: () => void
  onResume?: (token: string) => void
  onExpired?: () => void
}

const toolbarPreference = 'outpost.terminal.toolbar-hidden'
function savedToolbar() {
  try {
    const stored = localStorage.getItem(toolbarPreference)
    return stored === null ? !desktop : stored !== 'true'
  } catch {
    return true
  }
}

export default function TerminalView({ token, title, onClose, onResume, onExpired }: Props) {
  const surface = useRef<HTMLDivElement>(null),
    chooser = useRef<HTMLInputElement>(null)
  const terminal = useRef<Terminal | null>(null),
    socket = useRef<TerminalSocket | null>(null)
  const clipboard = useRef<ReturnType<typeof attachClipboard> | null>(null)
  const bell = useRef<ReturnType<typeof attachBell> | null>(null)
  const [state, setState] = useState<SocketState>({ kind: 'connecting' })
  const [activity, setActivity] = useState<SessionActivity | null>(null)
  const [name, setName] = useState(title)
  const sessionInfo = useRef({ id: '', name: title })
  const [bellRinging, setBellRinging] = useState(false)
  const [status, setStatus] = useState('')
  const [blockedLink, setBlockedLink] = useState<string | null>(null)
  const [keysShown, setKeysShown] = useState(touch)
  const [composerShown, setComposerShown] = useState(touch)
  const [draft, setDraft] = useState('')
  const hasDraft = draft.length > 0
  const host = useRef<TerminalHostState>({ focused: false, fontSize: 13.5, sound: true })
  const [modifiers, setModifiers] = useState<TerminalModifiers>({})
  const armed = useRef<TerminalModifiers>({})
  const statusTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const connected = state.kind === 'connected'
  const [toolbarShown, setToolbarShown] = useState(savedToolbar)
  const lifecycle = useRef({ onResume, onExpired })
  useEffect(() => {
    lifecycle.current = { onResume, onExpired }
  }, [onResume, onExpired])
  const showToolbar = (shown: boolean) => {
    setToolbarShown(shown)
    try {
      localStorage.setItem(toolbarPreference, String(!shown))
    } catch {
      /* The layout preference is optional. */
    }
    terminal.current?.focus()
  }

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
  const arm = useCallback((next: TerminalModifiers) => {
    armed.current = next
    setModifiers(next)
  }, [])
  const pasteImage = useCallback(
    async (file: File) => {
      const problem = imageProblem(file)
      if (problem) return notify(problem)
      notify('Uploading image…', true)
      try {
        await socket.current!.pasteImage(await readImage(file), file.type as ImageMediaType)
        notify('Image pasted')
      } catch (error) {
        notify((error as Error).message)
      }
    },
    [notify],
  )

  useEffect(() => {
    const term = new Terminal({
      fontSize: 13.5,
      lineHeight: 1.15,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      theme,
      cursorBlink: true,
      scrollback: 2000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      // The shared context menu keeps the current selection on every platform.
      rightClickSelectsWord: false,
      logLevel: 'off',
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        void openBrowserTab(uri).then(opened => {
          if (!opened) setBlockedLink(uri)
        })
      }),
    )
    term.open(surface.current!)
    // Both clients use GPU rendering where available. Losing the GPU context
    // restores xterm's DOM renderer without losing the session or its buffer.
    let renderer: WebglAddon | undefined
    try {
      renderer = new WebglAddon()
      renderer.onContextLoss(() => renderer?.dispose())
      term.loadAddon(renderer)
    } catch {
      renderer?.dispose()
      // Remote desktops, driver failures and older browsers use the DOM renderer.
    }
    term.textarea?.setAttribute('aria-label', 'Terminal input')
    terminal.current = term
    const bells = attachBell(
      term,
      setBellRinging,
      () => sessionInfo.current,
      desktop
        ? {
            active: () => host.current.focused,
            sound: () => host.current.sound,
          }
        : undefined,
    )
    bell.current = bells
    const size = () => {
      const proposed = surface.current?.clientWidth ? fit.proposeDimensions() : undefined
      return {
        cols: Math.max(20, Math.min(400, proposed?.cols ?? 80)),
        rows: Math.max(5, Math.min(200, proposed?.rows ?? 24)),
      }
    }
    const client = new TerminalSocket(token, size, {
      output: (bytes, rendered) => term.write(bytes, rendered),
      state: next => {
        setState(next)
        if (next.kind === 'closed' && next.reason === 'expired') lifecycle.current.onExpired?.()
        if (next.kind === 'connected' && !touch() && (!desktop || (host.current.focused && document.hasFocus())))
          term.focus()
      },
      hello: message => {
        lifecycle.current.onResume?.(message.resume)
        sessionInfo.current = {
          id: `${message.target.id}/${message.session.id}`,
          name: `${message.session.name} · ${message.target.name}`,
        }
        setName(sessionInfo.current.name)
      },
      activity: next => activityController.update(next),
      signal: ({ signal }) => {
        if (signal.type !== 'browser.open') return
        let url: string
        try {
          url = browserUrl(signal.payload)
        } catch {
          return
        }
        void openBrowserTab(url).then(opened => {
          if (!opened) setBlockedLink(url)
        })
      },
    })
    socket.current = client
    const activityController = new TerminalActivity(client, setActivity, message => notify(message, true))
    const active = () =>
      desktop ? host.current.focused : document.visibilityState === 'visible' && document.hasFocus()
    const activityFocus = () => activityController.setActive(active())
    const acknowledgeActivity = () => {
      activityFocus()
      activityController.acknowledge()
    }
    activityFocus()
    window.addEventListener('focus', activityFocus)
    window.addEventListener('blur', activityFocus)
    document.addEventListener('visibilitychange', activityFocus)
    window.addEventListener('click', acknowledgeActivity, true)
    window.addEventListener('keydown', acknowledgeActivity, true)
    const shims = attachClipboard(term, {
      connected: () => client.connected,
      pasteImage: file => void pasteImage(file),
      status: notify,
    })
    clipboard.current = shims
    term.onData(data => {
      const current = armed.current
      if ((current.ctrl || current.alt) && [...data].length === 1) {
        data = terminalKey(data, current) ?? data
        arm({})
      }
      client.input(data)
    })
    term.onBinary(data => client.input(Uint8Array.from(data, character => character.charCodeAt(0))))
    term.attachCustomKeyEventHandler(event => {
      if (!shims.handleKey(event)) return false
      // Coding tools read Shift+Enter as a newline; xterm would send a plain Enter.
      if (
        event.type === 'keydown' &&
        event.key === 'Enter' &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey
      ) {
        event.preventDefault()
        client.input('\x1b[13;2u')
        return false
      }
      return true
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const refit = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const { cols, rows } = size()
        if (term.cols !== cols || term.rows !== rows) {
          term.resize(cols, rows)
          client.resize(cols, rows)
        }
      }, 60)
    }
    const observer = new ResizeObserver(refit)
    observer.observe(surface.current!)
    window.visualViewport?.addEventListener('resize', refit)
    const initial = size()
    term.resize(initial.cols, initial.rows)
    const focusInput = () => {
      const active = document.activeElement
      // Native pane activation can arrive after the local menu has opened.
      if (active instanceof HTMLElement && active.closest('[role="menu"]')) active.focus()
      else if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) active.focus()
      else term.focus()
    }
    const stopCommands = desktop?.onCommand(command => {
      if (command === 'focus') {
        focusInput()
        if (active()) {
          bells.acknowledge()
          acknowledgeActivity()
        }
      } else if (command === 'reconnect') client.reconnect()
      else {
        const active = document.activeElement
        if (active !== term.textarea && (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement))
          active.select()
        else term.selectAll()
      }
    })
    const stopHost = desktop?.onHostState(next => {
      const focused = next.focused && !host.current.focused
      host.current = next
      activityFocus()
      if (term.options.fontSize !== next.fontSize) {
        term.options.fontSize = next.fontSize
        refit()
      }
      if (focused) {
        bells.acknowledge()
        // Native focus commands own activation. A delayed host-state update
        // must not steal focus from the tab strip during a click or drag.
      }
    })
    // Launch tokens are single use: open after the commit, so a discarded
    // render (React StrictMode) never spends the token.
    const start = setTimeout(() => client.open(), 0)
    const launches = new Set<string>()
    const stopLaunches = desktop?.onLaunch(launch => {
      if (launches.has(launch)) return
      launches.add(launch)
      if (launches.size > 32) launches.delete(launches.values().next().value!)
      clearTimeout(start)
      if (!client.connected) lifecycle.current.onResume?.(launch)
      void client
        .activate(launch)
        .catch(error => notify((error as Error).message))
        .finally(() => {
          void desktop?.launchHandled(launch).catch(() => {})
        })
    })
    return () => {
      clearTimeout(start)
      clearTimeout(timer)
      observer.disconnect()
      window.visualViewport?.removeEventListener('resize', refit)
      window.removeEventListener('focus', activityFocus)
      window.removeEventListener('blur', activityFocus)
      document.removeEventListener('visibilitychange', activityFocus)
      window.removeEventListener('click', acknowledgeActivity, true)
      window.removeEventListener('keydown', acknowledgeActivity, true)
      client.close()
      activityController.dispose()
      bells.dispose()
      shims.dispose()
      stopCommands?.()
      stopHost?.()
      stopLaunches?.()
      term.dispose()
      socket.current = null
      terminal.current = null
      clipboard.current = null
      bell.current = null
    }
  }, [token, arm, notify, pasteImage])

  const press = (key: string, extra?: TerminalModifiers) => {
    const data = terminalKey(key, { ...armed.current, ...extra }, terminal.current?.modes.applicationCursorKeysMode)
    if (data !== null) {
      socket.current?.input(data)
      arm({})
    }
  }
  const send = async (text: string) => {
    const normalized = text.replace(/\r?\n/g, '\r')
    const bracketed = terminal.current?.modes.bracketedPasteMode
    await socket.current!.submit(`${bracketed ? `\x1b[200~${normalized}\x1b[201~` : normalized}\r`)
  }
  const label =
    state.kind === 'connected'
      ? 'Connected'
      : state.kind === 'connecting'
        ? 'Connecting…'
        : state.kind === 'reconnecting'
          ? `Reconnecting… (${state.attempt})`
          : state.reason === 'detached'
            ? 'Detached'
            : 'Disconnected'

  return (
    <div className="terminal-view" role="dialog" aria-label={`Web terminal · ${name}`}>
      <header className="terminal-bar" hidden={!toolbarShown}>
        <div className="terminal-title">
          <strong>{name}</strong>
          <span className={`terminal-state ${state.kind}`}>
            {state.kind === 'connecting' || state.kind === 'reconnecting' ? (
              <LoaderCircle className="spin" size={12} />
            ) : (
              <i />
            )}
            {label}
          </span>
          {status && (
            <span className="terminal-status" role="status">
              {status}
            </span>
          )}
        </div>
        <div className="terminal-actions">
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
            title="Close terminal (the session keeps running)"
            aria-label="Close terminal"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
      </header>
      {!toolbarShown && (
        <>
          <button
            className="icon-button terminal-show-toolbar"
            title="Show terminal toolbar"
            aria-label="Show terminal toolbar"
            onClick={() => showToolbar(true)}
          >
            <PanelTopOpen size={17} />
          </button>
          {(status || state.kind === 'connecting' || state.kind === 'reconnecting') && (
            <div className="terminal-notice" role="status">
              {status || label}
            </div>
          )}
        </>
      )}
      {blockedLink && (
        <div className="terminal-notice">
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
      <div className="terminal-body">
        <TerminalContextMenu
          connected={connected}
          actions={{
            canCopy: () => clipboard.current?.canCopy() ?? false,
            copy: () => void clipboard.current?.copy(),
            paste: () => void clipboard.current?.paste(),
            selectAll: () => terminal.current?.selectAll(),
            pasteImage: () => chooser.current?.click(),
            focus: () => terminal.current?.focus(),
          }}
          controls={[
            { label: 'Terminal toolbar', shown: toolbarShown, onChange: showToolbar },
            { label: 'Message box', shown: composerShown, onChange: setComposerShown },
            { label: 'On-screen keys', shown: keysShown, onChange: setKeysShown },
          ]}
        >
          <div className="terminal-surface" ref={surface} />
        </TerminalContextMenu>
        {bellRinging && (
          <div className="terminal-notice terminal-bell" role="status">
            <Bell size={16} aria-hidden="true" />
            <span>{name} rang a bell</span>
            <button
              className="icon-button"
              aria-label="Dismiss bell notification"
              onClick={() => bell.current?.acknowledge()}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {state.kind === 'closed' && (
          <div className="terminal-closed">
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
                  <button className="button primary" onClick={() => socket.current?.reconnect()}>
                    <RotateCw size={15} />
                    Reconnect
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
            arm(next)
            if (!touch()) terminal.current?.focus()
          }}
          onKey={press}
          onCopy={() => void clipboard.current?.copy()}
          onPaste={() => void clipboard.current?.paste()}
        />
      )}
      <Composer enabled={connected} visible={composerShown} text={draft} onChange={setDraft} onSend={send} />
    </div>
  )
}
