import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { TerminalClientMessage, TerminalServerMessage, WebTerminalInfo } from '../shared/web-terminal'

export default function WebTerminal({ info, onRelaunch, onManageKey }: { info: WebTerminalInfo; onRelaunch: () => Promise<void>; onManageKey: () => void }) {
  const container = useRef<HTMLDivElement>(null), terminal = useRef<Terminal | null>(null), socket = useRef<WebSocket | null>(null)
  const [connection, setConnection] = useState('Connecting…'), [connected, setConnected] = useState(false)
  const [ctrl, setCtrl] = useState(false), ctrlArmed = useRef(false)
  const [text, setText] = useState('')
  const fitNow = useRef<() => void>(() => {})
  useEffect(() => {
    const term = new Terminal({ cols: info.cols, rows: info.rows, fontSize: 14, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', theme: { background: '#111827', foreground: '#e5e7eb', cursor: '#a7f3d0', selectionBackground: '#374151' }, cursorBlink: true, scrollback: 1000, convertEol: false, logLevel: 'off' })
    const fit = new FitAddon(); term.loadAddon(fit); term.open(container.current!); terminal.current = term
    term.textarea?.setAttribute('aria-label', 'Terminal input')
    term.textarea?.setAttribute('autocapitalize', 'off'); term.textarea?.setAttribute('autocomplete', 'off')
    let stopped = false, ready = false, attempts = 0, retry: ReturnType<typeof setTimeout> | undefined, resizeTimer: ReturnType<typeof setTimeout> | undefined
    const send = (message: TerminalClientMessage) => { if (ready && socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message)) }
    const fitTerminal = () => {
      if (!container.current?.clientHeight || !container.current.clientWidth) return
      const size = fit.proposeDimensions()
      if (!size) return
      const cols = Math.max(20, Math.min(300, size.cols)), rows = Math.max(5, Math.min(120, size.rows))
      if (term.cols !== cols || term.rows !== rows) { term.resize(cols, rows); send({ type: 'resize', cols, rows }) }
    }
    fitNow.current = fitTerminal
    const dialog = container.current!.closest('dialog')
    const scheduleFit = () => {
      const height = window.visualViewport?.height ?? window.innerHeight
      dialog?.classList.toggle('terminal-compact', height < 560)
      dialog?.style.setProperty('--terminal-viewport-height', `${height}px`)
      dialog?.style.setProperty('--terminal-viewport-top', `${window.visualViewport?.offsetTop ?? 0}px`)
      clearTimeout(resizeTimer); resizeTimer = setTimeout(fitTerminal, 80)
    }
    const observer = new ResizeObserver(scheduleFit); observer.observe(container.current!)
    window.visualViewport?.addEventListener('resize', scheduleFit)
    window.visualViewport?.addEventListener('scroll', scheduleFit)
    scheduleFit()
    const input = term.onData(data => {
      if (ctrlArmed.current && /^[a-zA-Z@[\]\\^_]$/.test(data)) { data = String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31); ctrlArmed.current = false; setCtrl(false) }
      send({ type: 'input', data })
    })
    term.attachCustomKeyEventHandler(event => {
      if (event.type === 'keydown' && event.shiftKey && event.key === 'Enter') { send({ type: 'input', data: '\x1b[13;2u' }); return false }
      return true
    })
    const connect = () => {
      if (stopped) return
      ready = false
      const url = new URL(`/api/web-terminals/${info.id}/socket`, window.location.origin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(url); ws.binaryType = 'arraybuffer'; socket.current = ws
      const ack = (bytes: number) => { if (!stopped && socket.current === ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ack', bytes })) }
      ws.onmessage = event => {
        if (stopped || socket.current !== ws) return
        if (event.data instanceof ArrayBuffer) { const bytes = new Uint8Array(event.data); term.write(bytes, () => ack(bytes.length)); return }
        const message: TerminalServerMessage = JSON.parse(event.data)
        if (message.type === 'snapshot') {
          term.reset(); term.resize(message.cols, message.rows)
          term.write(message.data, () => {
            if (stopped || socket.current !== ws) return
            ack(new TextEncoder().encode(message.data).length); ready = true; attempts = 0
            setConnected(true); setConnection('Connected'); fitTerminal()
            if (window.matchMedia('(pointer: fine)').matches) term.focus()
          })
        } else if (message.type === 'closed') { stopped = true; ready = false; setConnected(false); setConnection(message.message) }
      }
      ws.onclose = event => {
        ready = false; setConnected(false)
        if (event.code === 4001) { stopped = true; setConnection('This terminal was opened in another tab.'); return }
        if (stopped) return
        if (++attempts <= 8) { setConnection(`Connection lost. Reconnecting… (${attempts}/8)`); retry = setTimeout(connect, Math.min(10000, attempts * 1000)) }
        else setConnection('Connection ended. Relaunch to resume your coding session.')
      }
    }
    connect()
    return () => {
      stopped = true; clearTimeout(retry); clearTimeout(resizeTimer); observer.disconnect(); window.visualViewport?.removeEventListener('resize', scheduleFit); window.visualViewport?.removeEventListener('scroll', scheduleFit)
      socket.current?.close(); socket.current = null; input.dispose(); term.dispose(); terminal.current = null
    }
  }, [info])
  function send(data: string) {
    if (!connected || socket.current?.readyState !== WebSocket.OPEN) return
    if (new TextEncoder().encode(data).length > 16 * 1024) { setConnection('Input must fit within 16 KiB. Send smaller sections.'); return }
    socket.current.send(JSON.stringify({ type: 'input', data })); terminal.current?.focus()
  }
  return <div className="web-terminal">
    <div className="terminal-toolbar"><span role="status" className={connected ? 'terminal-connected' : ''}>{connection}</span>
      <div><button className="button secondary" onClick={() => terminal.current?.focus()}>Keyboard</button>
        <button className="button secondary" onClick={onManageKey}>Manage key</button>
        {!connected && <button className="button secondary" onClick={() => void onRelaunch()}>Relaunch</button>}</div></div>
    <div className="terminal-surface" ref={container} aria-label="SSH terminal" />
    <div className="terminal-keys" role="toolbar" aria-label="Terminal keys">
      <button type="button" disabled={!connected} aria-pressed={ctrl} onClick={() => { ctrlArmed.current = !ctrlArmed.current; setCtrl(ctrlArmed.current); terminal.current?.focus() }}>Ctrl</button>
      {([['Esc', '\x1b'], ['Tab', '\t'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'], ['Ctrl+C', '\x03'], ['Enter', '\r'], ['Shift+Enter', '\x1b[13;2u']] as const).map(([label, data]) => <button type="button" key={label} disabled={!connected} aria-label={label} onClick={() => send(data)}>{label}</button>)}
    </div>
    <form className="terminal-compose" onSubmit={event => { event.preventDefault(); send(text + '\r'); setText('') }}>
      <input aria-label="Terminal text" placeholder="Type or paste text…" value={text} autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={8000} disabled={!connected} onChange={event => setText(event.target.value)} onFocus={() => setTimeout(() => fitNow.current(), 250)} />
      <button className="button secondary" disabled={!connected} type="submit">Send</button>
    </form>
    <p className="terminal-hint">A dropped connection is held for {Math.round(info.reconnectSeconds / 60)} minutes. Use Close to detach now.</p>
  </div>
}
