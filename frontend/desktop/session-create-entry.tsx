import { createRoot } from 'react-dom/client'
import SessionCreatorPage from './SessionCreatorPage'
import '../styles/main.scss'
import './session-create.scss'

createRoot(document.getElementById('root')!).render(<SessionCreatorPage />)
