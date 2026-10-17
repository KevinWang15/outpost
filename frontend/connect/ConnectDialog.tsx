import { useState } from 'react'
import { AppWindow, ArrowRight, Monitor } from 'lucide-react'
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

  if (phase === 'opening')
    return (
      <Dialog
        title={`Connect to ${session.name}`}
        description={target.name}
        onClose={onClose}
        footer={
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
        }
      >
        <div className="connect-progress" role="status">
          <Monitor size={20} />
          <div>
            <strong>Continue in Outpost Desktop</strong>
            <p>
              Allow your browser to open Outpost. If this server is not connected in the app, finish sign-in and approve
              access in your browser.
            </p>
          </div>
        </div>
        <div className="connect-setup">
          <h3>Nothing opened?</h3>
          <p>Install Outpost Desktop for macOS or Windows and open it once, then try again.</p>
          <a className="button primary" href={pagePaths.desktop} target="_blank" rel="noopener noreferrer">
            Download Outpost Desktop
          </a>
          <p className="hint">Already installed? Open the app once to register its browser link, then try again.</p>
        </div>
      </Dialog>
    )

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
            onClick={() => {
              onChoose(choice.id, remember)
            }}
          >
            <span className="choice-icon">{choice.icon}</span>
            <span className="choice-text">
              <span className="choice-title">{choice.name}</span>
              <span className="choice-detail">{choice.detail}</span>
            </span>
            <ArrowRight size={18} className="choice-arrow" />
          </button>
        ))}
      </div>
      <label className="connect-remember">
        <input
          type="checkbox"
          checked={remember}
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
