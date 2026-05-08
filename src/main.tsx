import React, { StrictMode, Suspense } from 'react'
import ReactDOM from 'react-dom'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from 'react-error-boundary'
import './index.css'
import App from './App.tsx'
import { RepoProvider } from '@/context/repo.tsx'
import { Login } from '@/components/Login.tsx'
import { SuspenseFallback } from '@/components/util/suspense.tsx'
import { BootstrapErrorFallback } from '@/components/util/error.tsx'
import { preWarmPowerSync } from '@/data/preWarm.ts'
import { WASQLITE_WORKER_URL } from '@/data/repoProvider.ts'

// Tell the browser to fetch+parse the wa-sqlite worker bundle in
// parallel with React's bundle download. The PowerSync worker
// constructor (`new Worker(url)` later in `WASQLiteOpenFactory`) hits
// the HTTP cache instead of issuing a fresh round-trip. Cold-start
// instrumentation showed ~600ms inside `db.database.init()` (worker
// boot + WASM compile + OPFS handle), and the bundle fetch+parse is
// the part of that we can overlap with React's startup.
const preloadWorker = () => {
  try {
    const link = document.createElement('link')
    // setAttribute (not the `link.as = ...` setter) — Chrome/Safari
    // treat the property as a constrained enum and silently drop
    // values they don't classify, including "worker" via the setter.
    // The attribute path keeps the requested value verbatim, which is
    // what the preload scanner reads.
    link.setAttribute('rel', 'preload')
    link.setAttribute('as', 'worker')
    link.setAttribute('href', WASQLITE_WORKER_URL)
    document.head.appendChild(link)
  } catch {
    // Best-effort; document/head can't realistically be missing here,
    // but the rest of bootstrap doesn't depend on this succeeding.
  }
}
preloadWorker()

// Kick off PowerSync init in parallel with React's first render. Reads
// the user id synchronously from localStorage; the resulting init
// promise is memoized inside `ensurePowerSyncReady`, so the eventual
// `RepoProvider` await picks it up. Best-effort — if there's no logged
// in user yet (or localStorage is unavailable), the regular React-
// driven path takes over unchanged.
preWarmPowerSync()

// Todo remember why I need this something about version mismatch/having implied react in custom blocks
window.React = React
window.ReactDOM = ReactDOM

// The ErrorBoundary lives INSIDE Login so its fallback can call useSignOut,
// and OUTSIDE RepoProvider so a repo-bootstrap throw still gets caught and
// rendered as a recoverable UI instead of a blank screen.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<SuspenseFallback name="outer-bootstrap"/>}>
      <Login>
        <ErrorBoundary FallbackComponent={BootstrapErrorFallback}>
          <RepoProvider>
            <Suspense fallback={<SuspenseFallback name="app-init"/>}>
              <App/>
            </Suspense>
          </RepoProvider>
        </ErrorBoundary>
      </Login>
    </Suspense>
  </StrictMode>,
)
