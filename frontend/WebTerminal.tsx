import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Maximize2, Minimize2 } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import type { TerminalClientMessage, TerminalServerMessage, WebTerminalInfo } from '../shared/web-terminal'
import TerminalComposer from './TerminalComposer'
import { attachTerminalClipboard, type TerminalClipboardState } from './terminal-clipboard'
import { TerminalSubmit } from './terminal-submit'
import TerminalKeyboard from './TerminalKeyboard'
import { terminalKey, type TerminalModifiers } from './terminal-keyboard'
import { TerminalImagePaste, type TerminalImagePasteState } from './terminal-image-paste'
import { uploadSessionImage } from './image-upload'
import { terminalPaste } from './terminal-paste'

export default function WebTerminal({ info, targetId, sessionId, fullscreen, onFullscreenChange, onRelaunch, onManageKey, onSendingChange }: {
  info: WebTerminalInfo
  targetId: string
  sessionId: string
  fullscreen: boolean
  onFullscreenChange: (fullscreen: boolean) => void
  onRelaunch: () => Promise<void>
  onManageKey: () => void
  onSendingChange: (sending: boolean) => void
}) {
  const container = useRef<HTMLDivElement>(null), terminal = useRef<Terminal | null>(null), socket = useRef<WebSocket | null>(null)
  const ready = useRef(false)
  const submissions = useRef(new TerminalSubmit())
  const [connection, setConnection] = useState('Connecting…'), [connected, setConnected] = useState(false)
  const [modifiers, setModifiers] = useState<TerminalModifiers>({}), armed = useRef<TerminalModifiers>({})
  const updateModifiers = useCallback((next: TerminalModifiers) => { armed.current = next; setModifiers(next) }, [])
  const [sending, setSending] = useState(false)
  const composing = useRef(false), imagePaste = useRef<TerminalImagePaste | null>(null)
  const [imagePasteState, setImagePasteState] = useState<TerminalImagePasteState>(null)
  const [clipboardState, setClipboardState] = useState<TerminalClipboardState>({ canCopy: false, message: '' })
  const clipboard = useRef<ReturnType<typeof attachTerminalClipboard> | null>(null)
  const fitNow = useRef<() => void>(() => {})
  // A retained image belongs to the session, including after a terminal relaunch.
  useEffect(() => {
    const images = new TerminalImagePaste({
      connection: () => ready.current && socket.current?.readyState === WebSocket.OPEN ? socket.current : null,
      blocked: () => composing.current,
      upload: (file, signal) => uploadSessionImage(targetId, sessionId, file, signal),
      insert: (ws, reference) => submissions.current.send(ws, terminalPaste(reference, terminal.current!.modes.bracketedPasteMode)),
      onChange: state => {
        setImagePasteState(state)
        const busy = composing.current || Boolean(state?.busy)
        setSending(busy); onSendingChange(busy)
      },
    })
    imagePaste.current = images
    return () => { images.dispose(); imagePaste.current = null }
  }, [targetId, sessionId, onSendingChange])
  useEffect(() => {
    const submission = submissions.current
    const term = new Terminal({ cols: info.cols, rows: info.rows, fontSize: 14, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', theme: { background: '#111827', foreground: '#e5e7eb', cursor: '#a7f3d0', selectionBackground: '#374151' }, cursorBlink: true, scrollback: 1000, convertEol: false, logLevel: 'off' })
    const fit = new FitAddon(); term.loadAddon(fit); term.open(container.current!); terminal.current = term
    term.textarea?.setAttribute('aria-label', 'Terminal input')
    term.textarea?.setAttribute('autocapitalize', 'off'); term.textarea?.setAttribute('autocomplete', 'off')
    let stopped = false, attempts = 0, retry: ReturnType<typeof setTimeout> | undefined, resizeTimer: ReturnType<typeof setTimeout> | undefined
    const send = (message: TerminalClientMessage) => { if (ready.current && socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message)) }
    const fitTerminal = () => {
      if (!container.current?.clientHeight || !container.current.clientWidth) return
      const size = fit.proposeDimensions()
      if (!size) return
      const cols = Math.max(20, Math.min(300, size.cols)), rows = Math.max(5, Math.min(120, size.rows))
      if (term.cols !== cols || term.rows !== rows) { term.resize(cols, rows); send({ type: 'resize', cols, rows }) }
    }
    const dialog = container.current!.closest('dialog')
    const scheduleFit = () => {
      const viewport = window.visualViewport, height = viewport?.height ?? window.innerHeight
      dialog?.classList.toggle('terminal-compact', height < 560)
      dialog?.style.setProperty('--terminal-viewport-height', `${height}px`)
      dialog?.style.setProperty('--terminal-viewport-width', `${viewport?.width ?? window.innerWidth}px`)
      dialog?.style.setProperty('--terminal-viewport-top', `${viewport?.offsetTop ?? 0}px`)
      dialog?.style.setProperty('--terminal-viewport-left', `${viewport?.offsetLeft ?? 0}px`)
      clearTimeout(resizeTimer); resizeTimer = setTimeout(fitTerminal, 80)
    }
    fitNow.current = scheduleFit
    const observer = new ResizeObserver(scheduleFit); observer.observe(container.current!)
    window.addEventListener('resize', scheduleFit)
    window.visualViewport?.addEventListener('resize', scheduleFit)
    window.visualViewport?.addEventListener('scroll', scheduleFit)
    scheduleFit()
    const connection = () => ready.current && socket.current?.readyState === WebSocket.OPEN ? socket.current : null
    const terminalClipboard = attachTerminalClipboard(term, {
      connection,
      beforePaste: () => updateModifiers({}),
      pasteImage: file => imagePaste.current?.paste(file),
      onChange: setClipboardState,
    })
    clipboard.current = terminalClipboard
    const input = term.onData(data => {
      if ((armed.current.ctrl || armed.current.alt) && [...data].length === 1) { data = terminalKey(data, armed.current) ?? data; updateModifiers({}) }
      if (new TextEncoder().encode(data).length > 16 * 1024) { setConnection('Input must fit within 16 KiB. Send smaller sections.'); return }
      if (ready.current) setConnection('Connected')
      send({ type: 'input', data })
    })
    term.attachCustomKeyEventHandler(event => {
      if (!terminalClipboard.handleKeyEvent(event)) return false
      if (event.type === 'keydown' && !event.isComposing && (armed.current.ctrl || armed.current.alt)) {
        const data = terminalKey(event.key, { ctrl: armed.current.ctrl || event.ctrlKey, alt: armed.current.alt || event.altKey, shift: event.shiftKey }, term.modes.applicationCursorKeysMode)
        if (data !== null) { event.preventDefault(); updateModifiers({}); send({ type: 'input', data }); return false }
      }
      if (event.type === 'keydown' && event.shiftKey && event.key === 'Enter') { send({ type: 'input', data: '\x1b[13;2u' }); return false }
      return true
    })
    const connect = () => {
      if (stopped) return
      ready.current = false; setConnected(false)
      const url = new URL(`/api/web-terminals/${info.id}/socket`, window.location.origin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(url); ws.binaryType = 'arraybuffer'; socket.current = ws
      const ack = (bytes: number) => { if (!stopped && socket.current === ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ack', bytes })) }
      ws.onmessage = event => {
        if (stopped || socket.current !== ws) return
        if (event.data instanceof ArrayBuffer) { const bytes = new Uint8Array(event.data); term.write(bytes, () => ack(bytes.length)); return }
        const message: TerminalServerMessage = JSON.parse(event.data)
        if (message.type === 'snapshot') {
          ready.current = false
          term.reset(); terminalClipboard.reset(); term.resize(message.cols, message.rows)
          term.write(message.data, () => {
            if (stopped || socket.current !== ws) return
            ack(new TextEncoder().encode(message.data).length); ready.current = true; attempts = 0
            updateModifiers({}); setConnected(true); setConnection('Connected'); fitTerminal()
            if (window.matchMedia('(pointer: fine)').matches) term.focus()
          })
        } else if (message.type === 'input-result') submission.receive(ws, message)
        else if (message.type === 'closed') { submission.disconnect(ws); updateModifiers({}); stopped = true; ready.current = false; setConnected(false); setConnection(message.message) }
      }
      ws.onclose = event => {
        submission.disconnect(ws)
        if (stopped || socket.current !== ws) return
        ready.current = false; setConnected(false); updateModifiers({})
        if (event.code === 4001) { stopped = true; setConnection('This terminal was opened in another tab.'); return }
        if (++attempts <= 8) { setConnection(`Connection lost. Reconnecting… (${attempts}/8)`); retry = setTimeout(connect, Math.min(10000, attempts * 1000)) }
        else setConnection('Connection ended. Relaunch to resume your coding session.')
      }
    }
    connect()
    return () => {
      stopped = true; clearTimeout(retry); clearTimeout(resizeTimer); observer.disconnect(); window.removeEventListener('resize', scheduleFit); window.visualViewport?.removeEventListener('resize', scheduleFit); window.visualViewport?.removeEventListener('scroll', scheduleFit)
      fitNow.current = () => {}
      ready.current = false
      submission.disconnect()
      terminalClipboard.dispose(); clipboard.current = null
      socket.current?.close(); socket.current = null; input.dispose(); term.dispose(); terminal.current = null
    }
  }, [info, updateModifiers])
  useEffect(() => { fitNow.current() }, [fullscreen])
  function send(data: string) {
    if (!ready.current || socket.current?.readyState !== WebSocket.OPEN) return
    if (new TextEncoder().encode(data).length > 16 * 1024) { setConnection('Input must fit within 16 KiB. Send smaller sections.'); return }
    socket.current.send(JSON.stringify({ type: 'input', data }))
    if (window.matchMedia('(pointer: fine)').matches) terminal.current?.focus()
  }
  async function sendComposer(text: string) {
    if (!ready.current || !terminal.current || socket.current?.readyState !== WebSocket.OPEN) throw new Error('Terminal disconnected. Reconnect to send your draft.')
    const data = terminalPaste(text, terminal.current.modes.bracketedPasteMode) + '\r'
    if (new TextEncoder().encode(data).length > 16 * 1024) throw new Error('Input must fit within 16 KiB. Send smaller sections.')
    await submissions.current.send(socket.current, data)
    if (window.matchMedia('(pointer: fine)').matches) terminal.current?.focus()
  }
  return <div className="web-terminal">
    <div className="terminal-toolbar"><span role="status" className={connected ? 'terminal-connected' : ''}>{connection}{connected && clipboardState.message && <> · <span className="terminal-clipboard-status">{clipboardState.message}</span></>}</span>
      <div><button className="button secondary" onClick={() => terminal.current?.focus()}>Keyboard</button>
        <button className="button secondary" disabled={sending} onClick={onManageKey}>Manage key</button>
        <button className="button secondary terminal-fullscreen-toggle" aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} aria-pressed={fullscreen} onClick={() => onFullscreenChange(!fullscreen)}>{fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button>
        {!connected && <button className="button secondary" disabled={sending} onClick={() => void onRelaunch()}>Relaunch</button>}</div></div>
    <div className="terminal-surface" ref={container} aria-label="SSH terminal" />
    <TerminalKeyboard connected={connected} canCopy={clipboardState.canCopy} modifiers={modifiers} onModifiers={next => {
      updateModifiers(next)
      if (window.matchMedia('(pointer: fine)').matches) terminal.current?.focus()
    }} onKey={(key, extra) => {
      const data = terminalKey(key, { ...armed.current, ...extra }, terminal.current?.modes.applicationCursorKeysMode)
      if (data !== null) { send(data); updateModifiers({}) }
    }} onCopy={() => void clipboard.current?.copy()} onPaste={() => void clipboard.current?.paste()} />
    {imagePasteState && <div className="terminal-image-paste" role={imagePasteState.busy ? 'status' : 'alert'}>
      <span>{imagePasteState.message}</span>
      {!imagePasteState.busy && <div>{imagePasteState.canRetry && <button className="button secondary" disabled={!connected || sending} onClick={() => void imagePaste.current?.retry()}>Retry image paste</button>}
        <button className="button secondary" onClick={() => imagePaste.current?.dismiss()}>Dismiss</button></div>}
    </div>}
    <TerminalComposer targetId={targetId} sessionId={sessionId} connected={connected && !imagePasteState?.busy} onSend={sendComposer} onBusyChange={busy => {
      composing.current = busy
      const pending = busy || Boolean(imagePaste.current?.busy)
      setSending(pending); onSendingChange(pending)
    }} />
    <p className="terminal-hint">A dropped connection is held for {Math.round(info.reconnectSeconds / 60)} minutes. Use Close to detach now.</p>
  </div>
}
