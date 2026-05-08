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
