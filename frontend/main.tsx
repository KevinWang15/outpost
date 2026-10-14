import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Root from './Root'
import { ToastProvider } from './ui/Toast'
import './styles/main.scss'
import { takeAppTicket } from './terminal/appTicket'
import { pagePaths } from '../shared/pages'

const desktopTerminal = window.location.pathname === pagePaths.desktopTerminal
// Strip launch credentials before rendering anything or making API requests.
const ticket = desktopTerminal ? takeAppTicket() : null

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <Root desktopTerminal={desktopTerminal} ticket={ticket} />
    </ToastProvider>
  </StrictMode>,
)
