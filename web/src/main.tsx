import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AppFailed, ErrorBoundary } from './components/ErrorBoundary.tsx'
import { startUsageCounts } from './lib/analytics.ts'

// /admin: the password-protected admin page (its code is only downloaded there).
const isAdmin = window.location.pathname.replace(/\/+$/, '') === '/admin'
const AdminPage = lazy(() => import('./components/AdminPage.tsx'))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary name="App" fallback={<AppFailed />}>
      {isAdmin ? (
        <Suspense fallback={null}>
          <AdminPage />
        </Suspense>
      ) : (
        <App />
      )}
    </ErrorBoundary>
  </StrictMode>,
)

if (!isAdmin) startUsageCounts()

// Offline support (production builds only; in dev a service worker would serve stale code).
// Registered after load so it never competes with the first screen for bandwidth.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('Service worker not registered', err))
  })
}
