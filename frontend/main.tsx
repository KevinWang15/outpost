import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Root from './Root'
import { ToastProvider } from './ui/Toast'
import './styles/main.scss'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <Root />
    </ToastProvider>
  </StrictMode>,
)
