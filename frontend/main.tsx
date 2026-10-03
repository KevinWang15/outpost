import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LucideProvider } from 'lucide-react'
import App from './App'
import AuthGate from './AuthGate'
import './style.scss'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LucideProvider size={18}>
      <AuthGate><App /></AuthGate>
    </LucideProvider>
  </StrictMode>,
)
