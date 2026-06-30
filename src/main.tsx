import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppShell } from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
)
