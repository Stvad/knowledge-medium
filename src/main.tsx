// main is a BOOT SHIM — do not grow it. It mounts the provider/boundary stack
// and the pre-React instrumentation, nothing else. New app-root behavior goes
// into an overridable seam — a block renderer (like TopLevelRenderer), a
// facet, or the layout-root hook (usePanelLayoutProjection / LayoutRootContext).
// See the perspective keep-alive RFC (PR #357).
import React, { StrictMode, Suspense } from 'react'
import ReactDOM from 'react-dom'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from 'react-error-boundary'
import './index.css'
import App from './App.tsx'
import { RepoProvider } from '@/context/repo.js'
import { Login } from '@/components/Login.js'
import { SuspenseFallback } from '@/components/util/suspense.js'
import { BootstrapErrorFallback, LocalDbCorruptionSentinel } from '@/components/util/error.js'
import { registerServiceWorker } from '@/registerServiceWorker.js'
import { requestPersistentStorage } from '@/requestPersistentStorage.js'
import { setDevAssertionsEnabled } from '@/data/internals/devAssertions.js'
import { startStartupObservers } from '@/utils/startupTimeline.js'
import { installDbForensicsLifecycle } from '@/utils/dbForensicsHooks.js'

// Begin tracking main-thread long tasks immediately, so the startup-metrics
// plugin can later find when boot contention stopped (time to interactivity).
startStartupObservers()

// Out-of-band local-DB corruption instrumentation (issue #284): lifecycle
// breadcrumbs + a clean-shutdown flag, so the next OPFS corruption is
// self-diagnosing (a still-unclean flag on boot ⇒ the process was killed).
installDbForensicsLifecycle()

// L2 data-integrity invariant assertions: on in dev builds, compiled-away to a
// constant false in prod (import.meta.env.DEV is statically replaced by Vite).
setDevAssertionsEnabled(import.meta.env.DEV)

// Todo remember why I need this something about version mismatch/having implied react in custom blocks
window.React = React
window.ReactDOM = ReactDOM

registerServiceWorker()

// Ask the browser to keep our local-first state (SQLite DB, workspace keys)
// exempt from automatic eviction under storage pressure. Checks persisted()
// first, never re-prompts a user who explicitly declined, and otherwise asks
// at most once per session (so a silent Chromium denial still retries next
// session). See src/requestPersistentStorage.ts.
void requestPersistentStorage()

// The ErrorBoundary lives INSIDE Login so its fallback can call useSignOut,
// and OUTSIDE RepoProvider so a repo-bootstrap throw still gets caught and
// rendered as a recoverable UI instead of a blank screen.
// The toast surface is contributed via `appMountsFacet`
// (toastAppMountExtension) so plugin code stays the one source of
// truth for "what mounts at the app root". Bootstrap errors before
// the runtime is up still flow through ErrorBoundary →
// BootstrapErrorFallback below, not via toast.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<SuspenseFallback/>}>
      <Login>
        <ErrorBoundary FallbackComponent={BootstrapErrorFallback}>
          {/* Routes a RUNTIME sync-apply corruption (which opens fine, so it
              never throws through init) into this same boundary → recovery UI. */}
          <LocalDbCorruptionSentinel />
          <RepoProvider>
            <Suspense fallback={<SuspenseFallback/>}>
              <App/>
            </Suspense>
          </RepoProvider>
        </ErrorBoundary>
      </Login>
    </Suspense>
  </StrictMode>,
)
