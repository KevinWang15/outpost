import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Root from './Root'
import { ToastProvider } from './ui/Toast'
import './styles/main.scss'
import { takeDesktopTicket } from './terminal/desktopTicket'
import { pagePaths } from '../shared/pages'

const desktopTerminal = window.location.pathname === pagePaths.desktopTerminal
// Consume direct browser grants before rendering; native tabs use their preload.
const ticket = desktopTerminal ? takeDesktopTicket() : null

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <Root desktopTerminal={desktopTerminal} ticket={ticket} />
    </ToastProvider>
  </StrictMode>,
)
