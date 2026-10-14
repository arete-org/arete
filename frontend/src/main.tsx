import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initializeTheme } from './lib/theme'
import { buildAuthConfig } from './components/auth/buildConfig'
import { captureInstallPrompt } from './lib/install'
import { recoverChunkErrors } from './lib/chunkReload'

initializeTheme()
captureInstallPrompt()
recoverChunkErrors()

// Sign-in known from the build: fetch the Clerk chunk now, alongside the app's
// first render, rather than once the gate mounts. A failure resurfaces there.
if (buildAuthConfig()?.publishable_key) {
  import('./components/auth/ClerkGate').catch(() => {})
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
