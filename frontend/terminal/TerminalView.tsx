import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { ImagePlus, Keyboard, LoaderCircle, MessageSquareText, RotateCw, X } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import type { ImageMediaType } from '../../shared/model'
import { imageMediaTypes } from '../../shared/model'
import { browserUrl } from '../../shared/signals'
import { readImage } from '../api'
import { attachClipboard, imageProblem } from './clipboard'
import Composer from './Composer'
import KeyBar from './KeyBar'
import { terminalKey, type TerminalModifiers } from './keys'
import { TerminalSocket, type SocketState } from './socket'

const touch = () => window.matchMedia('(pointer: coarse)').matches
const theme = {
  background: '#0f172a', foreground: '#e2e8f0', cursor: '#93c5fd', cursorAccent: '#0f172a', selectionBackground: '#334155',
  black: '#1e293b', red: '#f87171', green: '#4ade80', yellow: '#facc15', blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e2e8f0',
  brightBlack: '#64748b', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde68a', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#f8fafc',
}

function openLink(url: string) {
  // Open a blank tab first so a blocked popup is detectable, then drop the opener.
  const tab = window.open('about:blank', '_blank')
  if (!tab) return false
  try { tab.opener = null; tab.location.replace(url); return true } catch { tab.close(); return false }
}

export default function TerminalView({ token, title, onClose }: { token: string; title: string; onClose: () => void }) {
  const surface = useRef<HTMLDivElement>(null), chooser = useRef<HTMLInputElement>(null)
  const terminal = useRef<Terminal | null>(null), socket = useRef<TerminalSocket | null>(null)
  const clipboard = useRef<ReturnType<typeof attachClipboard> | null>(null)
  const [state, setState] = useState<SocketState>({ kind: 'connecting' })
  const [name, setName] = useState(title)
  const [status, setStatus] = useState('')
  const [blockedLink, setBlockedLink] = useState<string | null>(null)
  const [keysShown, setKeysShown] = useState(touch)
  const [composerShown, setComposerShown] = useState(touch)
  const [modifiers, setModifiers] = useState<TerminalModifiers>({})
  const armed = useRef<TerminalModifiers>({})
  const statusTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const connected = state.kind === 'connected'

  const notify = useCallback((message: string, sticky = false) => {
    setStatus(message)
    clearTimeout(statusTimer.current)
    if (!sticky) statusTimer.current = setTimeout(() => setStatus(''), 4000)
  }, [])
  const arm = useCallback((next: TerminalModifiers) => { armed.current = next; setModifiers(next) }, [])
  const pasteImage = useCallback(async (file: File) => {
    const problem = imageProblem(file)
    if (problem) return notify(problem)
    notify('Uploading image…', true)
    try {
      await socket.current!.pasteImage(await readImage(file), file.type as ImageMediaType)
      notify('Image pasted')
    } catch (error) { notify((error as Error).message) }
  }, [notify])

  useEffect(() => {
    const term = new Terminal({
      fontSize: 13.5, lineHeight: 1.15, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      theme, cursorBlink: true, scrollback: 2000, allowProposedApi: true, macOptionIsMeta: true, macOptionClickForcesSelection: true, logLevel: 'off',
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.loadAddon(new WebLinksAddon((_event, uri) => { if (!openLink(uri)) setBlockedLink(uri) }))
    term.open(surface.current!)
    term.textarea?.setAttribute('aria-label', 'Terminal input')
    terminal.current = term
    const size = () => {
      const proposed = surface.current?.clientWidth ? fit.proposeDimensions() : undefined
      return { cols: Math.max(20, Math.min(400, proposed?.cols ?? 80)), rows: Math.max(5, Math.min(200, proposed?.rows ?? 24)) }
    }
    const client = new TerminalSocket(token, size, {
      output: (bytes, rendered) => term.write(bytes, rendered),
      state: next => { setState(next); if (next.kind === 'connected' && !touch()) term.focus() },
      hello: message => setName(`${message.session.name} · ${message.target.name}`),
      signal: ({ signal }) => {
        if (signal.type !== 'browser.open') return
        let url: string
        try { url = browserUrl(signal.payload) } catch { return }
        if (!openLink(url)) setBlockedLink(url)
      },
    })
    socket.current = client
    const shims = attachClipboard(term, { connected: () => client.connected, pasteImage: file => void pasteImage(file), status: notify })
    clipboard.current = shims
    term.onData(data => {
      const current = armed.current
      if ((current.ctrl || current.alt) && [...data].length === 1) { data = terminalKey(data, current) ?? data; arm({}) }
      client.input(data)
    })
    term.onBinary(data => client.input(Uint8Array.from(data, character => character.charCodeAt(0))))
    term.attachCustomKeyEventHandler(event => {
      if (!shims.handleKey(event)) return false
      // Coding tools read Shift+Enter as a newline; xterm would send a plain Enter.
      if (event.type === 'keydown' && event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault(); client.input('\x1b[13;2u'); return false
      }
      return true
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const refit = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const { cols, rows } = size()
        if (term.cols !== cols || term.rows !== rows) { term.resize(cols, rows); client.resize(cols, rows) }
      }, 60)
    }
    const observer = new ResizeObserver(refit)
    observer.observe(surface.current!)
    window.visualViewport?.addEventListener('resize', refit)
    const initial = size()
    term.resize(initial.cols, initial.rows)
    // Launch tokens are single use: open after the commit, so a discarded
    // render (React StrictMode) never spends the token.
    const start = setTimeout(() => client.open(), 0)
    return () => {
      clearTimeout(start); clearTimeout(timer); observer.disconnect(); window.visualViewport?.removeEventListener('resize', refit)
      client.close(); shims.dispose(); term.dispose()
      socket.current = null; terminal.current = null; clipboard.current = null
    }
  }, [token, arm, notify, pasteImage])

  const press = (key: string, extra?: TerminalModifiers) => {
    const data = terminalKey(key, { ...armed.current, ...extra }, terminal.current?.modes.applicationCursorKeysMode)
    if (data !== null) { socket.current?.input(data); arm({}) }
  }
  const send = async (text: string) => {
    const normalized = text.replace(/\r?\n/g, '\r')
    const bracketed = terminal.current?.modes.bracketedPasteMode
    await socket.current!.submit(`${bracketed ? `\x1b[200~${normalized}\x1b[201~` : normalized}\r`)
  }
  const label = state.kind === 'connected' ? 'Connected' : state.kind === 'connecting' ? 'Connecting…'
    : state.kind === 'reconnecting' ? `Reconnecting… (${state.attempt})` : state.reason === 'detached' ? 'Detached' : 'Disconnected'

  return <div className="terminal-view" role="dialog" aria-label={`Web terminal · ${name}`}>
    <header className="terminal-bar">
      <div className="terminal-title">
        <strong>{name}</strong>
        <span className={`terminal-state ${state.kind}`}>{state.kind === 'connecting' || state.kind === 'reconnecting' ? <LoaderCircle className="spin" size={12} /> : <i />}{label}</span>
        {status && <span className="terminal-status" role="status">{status}</span>}
      </div>
      <div className="terminal-actions">
        <input ref={chooser} type="file" hidden accept={imageMediaTypes.join(',')} onChange={event => {
          const file = event.target.files?.[0]; event.target.value = ''
          if (file) void pasteImage(file)
        }} />
        <button className="icon-button" title="Paste an image" aria-label="Paste an image" disabled={!connected} onClick={() => chooser.current?.click()}><ImagePlus size={17} /></button>
        <button className="icon-button" title="On-screen keys" aria-label="On-screen keys" aria-pressed={keysShown} onClick={() => setKeysShown(!keysShown)}><Keyboard size={17} /></button>
        <button className="icon-button" title="Message box" aria-label="Message box" aria-pressed={composerShown} onClick={() => setComposerShown(!composerShown)}><MessageSquareText size={17} /></button>
        <button className="icon-button" title="Close terminal (the session keeps running)" aria-label="Close terminal" onClick={onClose}><X size={18} /></button>
      </div>
    </header>
    {blockedLink && <div className="terminal-notice">
      <span>The session wants to open <code>{blockedLink}</code></span>
      <button className="button small primary" onClick={() => { if (openLink(blockedLink)) setBlockedLink(null) }}>Open link</button>
      <button className="button small" onClick={() => setBlockedLink(null)}>Dismiss</button>
    </div>}
    <div className="terminal-body">
      <div className="terminal-surface" ref={surface} />
      {state.kind === 'closed' && <div className="terminal-closed">
        <h3>{state.reason === 'detached' ? 'Detached' : state.reason === 'ended' ? 'Session ended' : state.reason === 'expired' ? 'Connection expired' : 'Disconnected'}</h3>
        <p>{state.message}</p>
        <div>
          {state.reason !== 'expired' && <button className="button primary" onClick={() => socket.current?.reconnect()}><RotateCw size={15} />Reconnect</button>}
          <button className="button" onClick={onClose}>Close</button>
        </div>
      </div>}
    </div>
    {keysShown && <KeyBar enabled={connected} modifiers={modifiers} onModifiers={next => { arm(next); if (!touch()) terminal.current?.focus() }}
      onKey={press} onCopy={() => void clipboard.current?.copy()} onPaste={() => void clipboard.current?.paste()} />}
    {composerShown && <Composer enabled={connected} onSend={send} />}
  </div>
}
