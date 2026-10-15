import { useState } from 'react'
import { AppWindow, ArrowRight, Check, LoaderCircle, Monitor } from 'lucide-react'
import { pagePaths } from '../../shared/pages'
import type { TerminalChoice } from '../../shared/terminals'
import type { Target } from '../../shared/model'
import { Dialog } from '../ui/Dialog'
import { preferredTerminal } from './preference'
import type { ConnectionState } from './useConnect'

/** Presentation for the shared connection flow; launches stay in click handlers. */
export default function ConnectDialog({
  target,
  connection: { session, phase, error },
  onChoose,
  onBack,
  onClose,
}: {
  target: Target
  connection: ConnectionState
  onChoose: (terminal: TerminalChoice, remember: boolean) => void
  onBack: () => void
  onClose: () => void
}) {
  const [remember, setRemember] = useState(() => preferredTerminal() !== null)

  if (phase.kind === 'opening' || phase.kind === 'connected')
    return (
      <Dialog
        title={`Connect to ${session.name}`}
        description={target.name}
        onClose={onClose}
        footer={
          phase.kind === 'opening' && (
            <>
              <button className="button" onClick={onBack}>
                Choose another terminal
              </button>
              <button
                className="button primary"
                onClick={() => {
                  onChoose('desktop', remember)
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
            className="choice"
            disabled={Boolean(busy)}
            onClick={() => {
              onChoose(choice.id, remember)
            }}
          >
            <span className="choice-icon">{choice.icon}</span>
            <span className="choice-text">
              <span className="choice-title">{choice.name}</span>
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
      <label className="connect-remember">
        <input
          type="checkbox"
          checked={remember}
          disabled={Boolean(busy)}
          onChange={event => setRemember(event.target.checked)}
          aria-describedby="connect-remember-hint"
        />
        Remember my choice
      </label>
      <p className="hint" id="connect-remember-hint">
        Connect directly next time without this dialog. Change or clear it in Connection preferences in the sidebar.
      </p>
      <p className="hint">
        <a href={pagePaths.desktop} target="_blank" rel="noopener noreferrer">
          Get Outpost Desktop
        </a>
      </p>
      <p className="hint">Closing a terminal only disconnects it. The session keeps running.</p>
    </Dialog>
  )
}
