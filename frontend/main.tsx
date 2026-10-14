import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Root from './Root'
import { ToastProvider } from './ui/Toast'
import './styles/main.scss'
import { takeAppTicket } from './terminal/appTicket'
import { pagePaths } from '../shared/pages'

const terminalApp = window.location.pathname === pagePaths.terminalApp
// Strip launch credentials before rendering anything or making API requests.
const ticket = terminalApp ? takeAppTicket() : null
if (terminalApp) {
  const manifest = document.createElement('link')
  manifest.rel = 'manifest'
  manifest.href = '/terminal.webmanifest'
  document.head.append(manifest)
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#0f172a')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <Root terminalApp={terminalApp} ticket={ticket} />
    </ToastProvider>
  </StrictMode>,
)
