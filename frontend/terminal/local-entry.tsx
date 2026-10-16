import { createRoot } from 'react-dom/client'
import type { LocalTerminalBridge } from '../../shared/localTerminal'
import { desktop } from '../desktop'
import TerminalView from './TerminalView'
import '../styles/main.scss'

declare global {
  interface Window {
    outpostLocalTerminal?: LocalTerminalBridge
  }
}

const local = window.outpostLocalTerminal
createRoot(document.getElementById('root')!).render(
  local && desktop ? (
    <TerminalView
      local={local}
      title="Local terminal"
      onClose={() => {
        void desktop?.close()
      }}
    />
  ) : (
    <main className="auth-loading" role="alert">
      Open this terminal from the Outpost app.
    </main>
  ),
)
