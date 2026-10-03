import { useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Copy, Folder, Link, Terminal } from 'lucide-react'
import type { Connection, Target, Session, TerminalShell } from '../shared/session-manager'
import { codingToolLabels } from '../shared/session-manager'
import { terminalApps, terminalOSLabels, type DesktopTerminal, type TerminalId } from '../shared/terminals'
import { api } from './api'
import { browserOS, orderedTerminalOS, rememberTerminal, terminalPreferences } from './terminals'
import { Modal } from './ui'

const SHIFT_ENTER_BINDING = `{
  "keys": "shift+enter",
  "command": { "action": "sendInput", "input": "\\u001b[13;2u" }
}`
export default function ConnectModal({
  targetId,
  kind,
  session,
  connection,
  notification,
  onClose,
}: {
  targetId: string
  kind: Target['kind']
  session: Session
  connection: Connection
  notification?: ReactNode
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false),
    [copyError, setCopyError] = useState(false)
  const [copiedBinding, setCopiedBinding] = useState(false)
  const [bindingCopyError, setBindingCopyError] = useState(false)
  const [launching, setLaunching] = useState(false),
    [launchError, setLaunchError] = useState(''),
    [launched, setLaunched] = useState('')
  const pendingLaunch = useRef(false)
  const osOrder = orderedTerminalOS(kind === 'local' ? connection.desktop.os : browserOS(), connection.desktop.os)
  const [terminalId, setTerminalId] = useState<TerminalId>(() => {
    const os = osOrder[0]
    const favorite = terminalPreferences()[os]
    if (favorite) return favorite
    const recommended = terminalApps.find(app => app.id === connection.desktop.recommendedId && app.os === os)
    return recommended?.id ?? terminalApps.find(app => app.os === os)!.id
  })
  const selected = terminalApps.find(app => app.id === terminalId)!
  const available = connection.desktop.terminals.find(app => app.id === terminalId)
  const [copyShell, setCopyShell] = useState<TerminalShell | null>(null)
  const shell = copyShell ?? selected.shell
  const localCompatible = kind !== 'local' || selected.os === connection.desktop.os
  const command = localCompatible ? connection.commands[shell] : undefined
  const shellChoices: TerminalShell[] = selected.os === 'windows' ? ['powershell', 'cmd', 'bash'] : ['bash']
  function selectTerminal(value: TerminalId) {
    setTerminalId(value)
    setCopyShell(null)
    setCopied(false)
    setCopyError(false)
    setLaunchError('')
    setLaunched('')
    rememberTerminal(value)
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(command ?? '')
      setCopyError(false)
      setCopied(true)
    } catch {
      setCopyError(true)
    }
  }
  async function copyBinding() {
    try {
      await navigator.clipboard.writeText(SHIFT_ENTER_BINDING)
      setCopiedBinding(true)
      setBindingCopyError(false)
    } catch {
      setBindingCopyError(true)
    }
  }
  async function launch() {
    if (pendingLaunch.current) return
    pendingLaunch.current = true
    setLaunching(true)
    setLaunchError('')
    setLaunched('')
    try {
      const terminal = await api<DesktopTerminal>(
        `/targets/${targetId}/sessions/${session.id}/launch`,
        'POST',
        { terminalId },
      )
      setLaunched(`Launch requested in ${terminal.name} on the computer running Outpost. Check your terminal window.`)
    } catch (error) {
      setLaunchError((error as Error).message)
    } finally {
      setLaunching(false)
      pendingLaunch.current = false
    }
  }
  return (
    <Modal
      title={`Connect to ${session.name}`}
      subtitle={
        kind === 'local'
          ? 'Choose a terminal on the computer running Outpost, using the same user account.'
          : 'Choose your favorite terminal to connect to this session.'
      }
      onClose={onClose}
    >
      <label className="terminal-choice">
        Terminal app
        <select
          value={terminalId}
          onChange={(event) => selectTerminal(event.target.value as TerminalId)}
          aria-describedby="terminal-help"
          disabled={launching}
        >
          {osOrder.map(os => (
            <optgroup key={os} label={`${terminalOSLabels[os]}${os === browserOS() ? ' · Your OS' : ''}${os === connection.desktop.os ? ' · Outpost computer' : ''}`}>
              {terminalApps.filter(app => app.os === os).map((app, index) => {
                const installed = connection.desktop.terminals.some(terminal => terminal.id === app.id)
                const recommended = os === connection.desktop.os && connection.desktop.recommendedId
                  ? app.id === connection.desktop.recommendedId : index === 0
                return <option key={app.id} value={app.id}>{app.name}{recommended ? ' · Recommended' : ''}{installed ? ' · Available' : ''}</option>
              })}
            </optgroup>
          ))}
        </select>
      </label>
      <p className="terminal-help" id="terminal-help">
        Choices are ordered by OS, then recommendation. Selecting an app saves your preference for {terminalOSLabels[selected.os]}.
      </p>
      {!connection.hosted && <div className="desktop-launch">
        {available ? <>
          <button className="button primary" onClick={launch} disabled={launching}>
            <Terminal />
            {launching ? 'Launching…' : 'Launch terminal'}
          </button>
          <p>
            Opens {available.name} with {available.shell === 'powershell' ? 'PowerShell' : 'Bash'} on the computer running Outpost.
          </p>
        </> : <p>
          {selected.os !== connection.desktop.os
            ? `Outpost is running on ${connection.desktop.os ? terminalOSLabels[connection.desktop.os] : 'another OS'}. To use ${selected.name} on your computer, copy the command below.`
            : connection.desktop.terminals.length === 0
              ? 'No desktop terminal was detected on the computer running Outpost. Copy the command to connect from your terminal.'
              : `${selected.name} is unavailable on the computer running Outpost. Choose an available app to launch, or copy the command below.`}
        </p>}
        <p>Direct Connect uses your saved preference for the Outpost computer’s OS, then falls back to an available terminal.</p>
        {launched && <p role="status">{launched}</p>}
        {launchError && <p role="alert" className="error">{launchError}</p>}
      </div>}
      <div className="manual-connection">
        <strong>Use an existing terminal</strong>
        <p>Open {selected.name} and paste this command. {connection.hosted ? 'Your computer needs its own SSH access to this server. Signing out expires this command.' : kind === 'local' ? 'Run it on the Outpost computer.' : 'You can connect from your own computer, including through an SSH tunnel to Outpost.'}</p>
        {localCompatible && shellChoices.some(shell => connection.commands[shell]) && <label className="terminal-choice">
          Shell for copy command
          <select value={shell} onChange={event => { setCopyShell(event.target.value as TerminalShell); setCopied(false); setCopyError(false) }}>
            {shellChoices.filter(shell => connection.commands[shell]).map(shell => <option key={shell} value={shell}>{shell === 'powershell' ? 'PowerShell' : shell === 'cmd' ? 'Command Prompt' : selected.os === 'windows' ? 'Bash (WSL / Git Bash)' : 'Bash'}</option>)}
          </select>
        </label>}
        {command ? <>
          <div className="command-box">
            <div>
              <span>{selected.name.toUpperCase()} · {shell.toUpperCase()}</span>
              <button className="copy-button" onClick={copy}>
                {copied ? <Check /> : <Copy />}
                {copied ? 'Copied' : 'Copy command'}
              </button>
            </div>
            <code>{command}</code>
          </div>
          {copyError && <p className="error">Clipboard unavailable. Select and copy the command above.</p>}
          <p className="terminal-help">{kind === 'local' ? selected.os === 'windows' ? 'Requires WSL on the Outpost computer.' : 'Requires Bash and curl.' : shell === 'bash' ? 'Requires Bash, curl, and OpenSSH.' : 'Requires OpenSSH Client.'}</p>
        </> : <p className="error">This local session requires a terminal on the {connection.desktop.os ? terminalOSLabels[connection.desktop.os] : 'Outpost'} computer. Select that OS to get a compatible command.</p>}
      </div>
      <div className="connect-details">
        <p>
          <Terminal />
          <span>
            Session backend: <strong>{session.backend}</strong>
          </span>
        </p>
        <p>
          <Terminal />
          <span>
            Coding tool: <strong>{codingToolLabels[session.tool]}</strong>
          </span>
        </p>
        <p>
          <Folder />
          <code>{session.rootDir}</code>
        </p>
        <p>
          <Link />
          <span>
            Command expires at{' '}
            {new Date(connection.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.
            The session stays available.
          </span>
        </p>
      </div>
      <div className="form-note">
        <Terminal />
        <p>
          Detach with <kbd>Ctrl</kbd> + <kbd>\</kbd> or close the terminal. {codingToolLabels[session.tool]}{' '}
          keeps running on the target. Reconnect here whenever you’re ready.
        </p>
      </div>
      <details className="keyboard-help">
        <summary><ChevronDown size={14} aria-hidden="true" /> Newline with Shift+Enter</summary>
        <div>
          {selected.id === 'windows-terminal' ? (
            <>
              <p>
                If Windows Terminal does not send Shift+Enter, open Settings, then “Open JSON file”.
                Add this entry to the existing <code>actions</code> array in <code>settings.json</code>,
                keeping your other entries:
              </p>
              <div className="binding-box">
                <button className="copy-button" onClick={copyBinding}>
                  {copiedBinding ? <Check /> : <Copy />}
                  {copiedBinding ? 'Binding copied' : 'Copy keybinding'}
                </button>
                <code>{SHIFT_ENTER_BINDING}</code>
              </div>
              {bindingCopyError && <p className="error" role="alert">Clipboard unavailable. Select and copy the keybinding above.</p>}
              <p>
                Without the keybinding, <kbd>Ctrl</kbd> + <kbd>Enter</kbd> or <kbd>Ctrl</kbd> +{' '}
                <kbd>J</kbd> inserts a newline.
              </p>
            </>
          ) : (
            <p>
              Shift+Enter needs a terminal that sends extended keys (CSI u or modifyOtherKeys).
              If it does not work, check your terminal’s keybindings or try <kbd>Ctrl</kbd> +{' '}
              <kbd>Enter</kbd> or <kbd>Ctrl</kbd> + <kbd>J</kbd> for a newline.
            </p>
          )}
        </div>
      </details>
      <p className="subtle">
        If {codingToolLabels[session.tool]} has exited, connecting starts a new{' '}
        {codingToolLabels[session.tool]} process in this session’s directory.
      </p>
      <div className="modal-actions">
        <button className="button primary" onClick={onClose}>
          Done
        </button>
      </div>
      {notification}
    </Modal>
  )
}
