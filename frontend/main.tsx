import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import AuthGate from './auth/AuthGate'
import { ToastProvider } from './ui/Toast'
import './styles/main.scss'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <AuthGate><App /></AuthGate>
    </ToastProvider>
  </StrictMode>,
)
