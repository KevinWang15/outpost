import { useEffect, useRef, useState } from 'react'
import { AppWindow, ArrowRight, Check, LoaderCircle, SquareTerminal } from 'lucide-react'
import type { Session, Target } from '../../shared/model'
import type { ConnectResponse, ConnectionStatus } from '../../shared/protocol'
import {
  clientOS,
  clientOSLabels,
  nativeTerminals,
  type ClientOS,
  type NativeTerminalId,
  type TerminalChoice,
} from '../../shared/terminals'
import { api } from '../api'
import { CopyField } from '../ui/CopyField'
import { Dialog } from '../ui/Dialog'

const remembered = 'outpost.terminal'
type Phase =
  | { kind: 'choose' }
  | { kind: 'requesting'; terminal: TerminalChoice }
  | { kind: 'opening'; terminal: NativeTerminalId; id: string; url: string; slow: boolean }
  | { kind: 'connected'; terminal: NativeTerminalId }

function lastChoice(): TerminalChoice | null {
  try {
    return localStorage.getItem(remembered) as TerminalChoice | null
  } catch {
    return null
  }
}

/** The one way to connect: choose the web terminal or a native terminal. */
export default function ConnectDialog({
  target,
  session,
  onClose,
}: {
  target: Target
  session: Session
  onClose: () => void
}) {
  const detected = clientOS(navigator.userAgent)
  const [os, setOs] = useState<ClientOS | 'all'>(detected ?? 'all')
  const [phase, setPhase] = useState<Phase>({ kind: 'choose' })
  const [error, setError] = useState('')
  const [install, setInstall] = useState('')
  const last = lastChoice()
  const alive = useRef(true)
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  async function choose(terminal: TerminalChoice) {
    setError('')
    setPhase({ kind: 'requesting', terminal })
    try {
      localStorage.setItem(remembered, terminal)
    } catch {
      /* Preference is optional. */
    }
    if (terminal === 'web') {
      // Open during the click; the new page requests its own connection token.
      const query = new URLSearchParams({
        target: target.id,
        session: session.id,
        title: `${session.name} · ${target.name}`,
      })
      const popup = window.open(`/terminal?${query}`, '_blank', 'popup,width=1200,height=800')
      if (!popup) {
        setError('Allow pop-ups for Outpost, then try opening the web terminal again.')
        setPhase({ kind: 'choose' })
        return
      }
      popup.opener = null
      onClose()
      return
    }
    try {
      const connection = await api<ConnectResponse>(`/targets/${target.id}/sessions/${session.id}/connect`, 'POST', {
        terminal,
      })
      if (!alive.current) return
      setPhase({ kind: 'opening', terminal, id: connection.id, url: connection.url!, slow: false })
      window.location.href = connection.url!
    } catch (problem) {
      if (alive.current) {
        setError((problem as Error).message)
        setPhase({ kind: 'choose' })
      }
    }
  }

  const openingId = phase.kind === 'opening' ? phase.id : null
  useEffect(() => {
    if (!openingId) return
    const started = Date.now()
    const timer = setInterval(async () => {
      try {
        const { status } = await api<ConnectionStatus>(`/connections/${openingId}`)
        if (!alive.current) return
        if (status === 'connected') {
          clearInterval(timer)
          setPhase(current =>
            current.kind === 'opening' ? { kind: 'connected', terminal: current.terminal } : current,
          )
          setTimeout(() => {
            if (alive.current) close.current()
          }, 1500)
        } else if (Date.now() - started > 6000)
          setPhase(current => (current.kind === 'opening' && !current.slow ? { ...current, slow: true } : current))
      } catch {
        /* Keep polling; the dialog stays useful offline. */
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [openingId])
  const slow = phase.kind === 'opening' && phase.slow
  useEffect(() => {
    if (!slow || install) return
    api<{ install: string }>('/connector').then(
      result => setInstall(result.install),
      () => {},
    )
  }, [slow, install])

  if (phase.kind === 'opening' || phase.kind === 'connected') {
    const terminal = nativeTerminals.find(item => item.id === phase.terminal)!
    return (
      <Dialog
        title={`Connect to ${session.name}`}
        description={target.name}
        onClose={onClose}
        footer={
          phase.kind === 'opening' && (
            <>
              <button className="button" onClick={() => setPhase({ kind: 'choose' })}>
                Back
              </button>
              <button
                className="button primary"
                onClick={() => {
                  window.location.href = phase.url
                }}
              >
                Open {terminal.name} again
              </button>
            </>
          )
        }
      >
        {phase.kind === 'connected' ? (
          <div className="connect-progress done" role="status">
            <Check size={20} />
            <div>
              <strong>Connected in {terminal.name}</strong>
              <p>You can close this window.</p>
            </div>
          </div>
        ) : (
          <div className="connect-progress" role="status">
            <LoaderCircle className="spin" size={20} />
            <div>
              <strong>Opening {terminal.name}…</strong>
              <p>Allow your browser to open Outpost Connector if it asks.</p>
            </div>
          </div>
        )}
        {slow && (
          <div className="connect-setup">
            <h3>Nothing opened?</h3>
            <p>
              Set up this computer once.{' '}
              {terminal.os === 'windows'
                ? 'In your WSL terminal (for example Ubuntu), run:'
                : 'In Terminal or iTerm2, run:'}
            </p>
            {install ? (
              <CopyField value={install} label="Connector install command" />
            ) : (
              <p className="muted">Loading the install command…</p>
            )}
            <ul>
              {terminal.requirements.map(requirement => (
                <li key={requirement}>{requirement}</li>
              ))}
            </ul>
            <p className="hint">
              Then choose “Open {terminal.name} again”. The installer trusts only this Outpost server.
            </p>
          </div>
        )}
      </Dialog>
    )
  }

  const options = nativeTerminals.filter(terminal => os === 'all' || terminal.os === os)
  const busy = phase.kind === 'requesting' ? phase.terminal : null
  return (
    <Dialog title={`Connect to ${session.name}`} description={`${target.name} · ${session.rootDir}`} onClose={onClose}>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="choices">
        <Choice
          icon={<AppWindow size={20} />}
          title="Web terminal"
          detail="Opens in a new window. Works on phones too."
          last={last === 'web'}
          busy={busy === 'web'}
          disabled={Boolean(busy)}
          onChoose={() => void choose('web')}
        />
      </div>
      <div className="choices-divider">
        <span>Native terminals</span>
        <label className="os-filter">
          <span className="sr-only">Operating system</span>
          <select value={os} onChange={event => setOs(event.target.value as ClientOS | 'all')}>
            <option value="all">All systems</option>
            {(Object.keys(clientOSLabels) as ClientOS[]).map(value => (
              <option key={value} value={value}>
                {clientOSLabels[value]}
                {value === detected ? ' (this computer)' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="choices">
        {options.map(terminal => (
          <Choice
            key={terminal.id}
            icon={<SquareTerminal size={20} />}
            title={terminal.name}
            tag={clientOSLabels[terminal.os]}
            detail={terminal.summary}
            shortcuts={terminal.shortcuts}
            last={last === terminal.id}
            busy={busy === terminal.id}
            disabled={Boolean(busy)}
            onChoose={() => void choose(terminal.id)}
          />
        ))}
        {!options.length && <p className="muted">No native terminals for this system yet. Use the web terminal.</p>}
      </div>
      <p className="hint">Closing a terminal only disconnects it. The session keeps running.</p>
    </Dialog>
  )
}

function Choice({
  icon,
  title,
  tag,
  detail,
  shortcuts,
  last,
  busy,
  disabled,
  onChoose,
}: {
  icon: React.ReactNode
  title: string
  tag?: string
  detail: string
  shortcuts?: readonly { keys: string; action: string }[]
  last: boolean
  busy: boolean
  disabled: boolean
  onChoose: () => void
}) {
  return (
    <button className={`choice ${last ? 'last' : ''}`} disabled={disabled} onClick={onChoose}>
      <span className="choice-icon">{icon}</span>
      <span className="choice-text">
        <span className="choice-title">
          {title}
          {tag && <span className="chip">{tag}</span>}
          {last && <span className="chip accent">Last used</span>}
        </span>
        <span className="choice-detail">{detail}</span>
        {shortcuts && (
          <span className="choice-keys">
            {shortcuts.map(shortcut => (
              <span key={shortcut.keys}>
                <kbd>{shortcut.keys}</kbd>
                {shortcut.action}
              </span>
            ))}
          </span>
        )}
      </span>
      {busy ? <LoaderCircle className="spin" size={18} /> : <ArrowRight size={18} className="choice-arrow" />}
    </button>
  )
}
