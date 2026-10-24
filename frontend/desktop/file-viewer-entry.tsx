import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import FileViewerPage from './FileViewerPage'
import '../styles/main.scss'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FileViewerPage />
  </StrictMode>,
)
