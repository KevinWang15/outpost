import { useEffect, useRef, useState } from 'react'
import { AppWindow, ArrowRight, Check, LoaderCircle, Monitor } from 'lucide-react'
import { pagePaths } from '../../shared/pages'
import { terminalChoices, type TerminalChoice } from '../../shared/terminals'
import type { Session, Target } from '../../shared/model'
import type { ConnectResponse, ConnectionStatus } from '../../shared/protocol'
import { api } from '../api'
import { Dialog } from '../ui/Dialog'

const remembered = 'outpost.terminal'
type Phase =
  | { kind: 'choose' }
  | { kind: 'requesting'; terminal: TerminalChoice }
  | { kind: 'opening'; id: string; slow: boolean }
  | { kind: 'connected' }

function lastChoice(): TerminalChoice | null {
  try {
    const value = localStorage.getItem(remembered)
    return terminalChoices.includes(value as TerminalChoice) ? (value as TerminalChoice) : null
  } catch {
    return null
  }
}

/** Two launch surfaces, one connection grant and terminal implementation. */
export default function ConnectDialog({
  target,
  session,
  onClose,
}: {
  target: Target
  session: Session
  onClose: () => void
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'choose' })
  const [error, setError] = useState('')
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
      /* Optional preference. */
    }
    if (terminal === 'web') {
      const query = new URLSearchParams({
        target: target.id,
        session: session.id,
        title: `${session.name} · ${target.name}`,
      })
      const popup = window.open(`${pagePaths.terminal}?${query}`, '_blank', 'popup,width=1200,height=800')
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
      setPhase({ kind: 'opening', id: connection.id, slow: false })
      window.location.assign(connection.url!)
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
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const { status } = await api<ConnectionStatus>(`/connections/${openingId}`)
        if (cancelled) return
        if (status === 'connected') {
          setPhase({ kind: 'connected' })
          return
        }
      } catch {
        /* Retrying or downloading stays available offline. */
      }
      if (cancelled) return
      if (Date.now() - started > 6000)
        setPhase(current => (current.kind === 'opening' ? { ...current, slow: true } : current))
      timer = setTimeout(() => {
        void poll()
      }, 1000)
    }
    timer = setTimeout(() => {
      void poll()
    }, 1000)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [openingId])
  useEffect(() => {
    if (phase.kind !== 'connected') return
    const timer = setTimeout(() => close.current(), 1500)
    return () => clearTimeout(timer)
  }, [phase.kind])

  if (phase.kind === 'opening' || phase.kind === 'connected')
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
                  void choose('desktop')
                }}
              >
                Open Outpost Desktop again
              </button>
            </>
          )
        }
      >
        <div className={`connect-progress ${phase.kind === 'connected' ? 'done' : ''}`} role="status">
          {phase.kind === 'connected' ? <Check size={20} /> : <LoaderCircle className="spin" size={20} />}
          <div>
            <strong>{phase.kind === 'connected' ? 'Connected in Outpost Desktop' : 'Opening Outpost Desktop…'}</strong>
            <p>
              {phase.kind === 'connected'
                ? 'You can close this window.'
                : 'Allow your browser to open Outpost. Confirm this server in the app on your first connection.'}
            </p>
          </div>
        </div>
        {phase.kind === 'opening' && phase.slow && (
          <div className="connect-setup">
            <h3>Nothing opened?</h3>
            <p>Install Outpost Desktop for macOS or Windows and open it once, then try again.</p>
            <a className="button primary" href={pagePaths.desktop} target="_blank" rel="noopener noreferrer">
              Download Outpost Desktop
            </a>
            <p className="hint">
              Each retry creates a fresh connection ticket. Chrome, Python, and WSL are not required.
            </p>
          </div>
        )}
      </Dialog>
    )

  const busy = phase.kind === 'requesting' ? phase.terminal : null
  return (
    <Dialog title={`Connect to ${session.name}`} description={`${target.name} · ${session.rootDir}`} onClose={onClose}>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="choices">
        {(
          [
            {
              id: 'web',
              name: 'Web terminal',
              detail: 'Opens in your browser. No installation needed. Works on phones too.',
              icon: <AppWindow size={20} />,
            },
            {
              id: 'desktop',
              name: 'Outpost Desktop',
              detail: 'Your own terminal window, app icon, and desktop notifications. For macOS and Windows.',
              icon: <Monitor size={20} />,
            },
          ] as const
        ).map(choice => (
          <button
            key={choice.id}
            className={`choice ${last === choice.id ? 'last' : ''}`}
            disabled={Boolean(busy)}
            onClick={() => {
              void choose(choice.id)
            }}
          >
            <span className="choice-icon">{choice.icon}</span>
            <span className="choice-text">
              <span className="choice-title">
                {choice.name}
                {last === choice.id && <span className="chip accent">Last used</span>}
              </span>
              <span className="choice-detail">{choice.detail}</span>
            </span>
            {busy === choice.id ? (
              <LoaderCircle className="spin" size={18} />
            ) : (
              <ArrowRight size={18} className="choice-arrow" />
            )}
          </button>
        ))}
      </div>
      <p className="hint">
        <a href={pagePaths.desktop} target="_blank" rel="noopener noreferrer">
          Get Outpost Desktop
        </a>
      </p>
      <p className="hint">Closing a terminal only disconnects it. The session keeps running.</p>
    </Dialog>
  )
}
