import React, { StrictMode, Suspense } from 'react'
import ReactDOM from 'react-dom'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { RepoProvider } from '@/context/repo.tsx'
import { Login } from '@/components/Login.tsx'
import { SuspenseFallback } from '@/components/util/suspense.tsx'
import { StorageProvider } from '@/context/storage.tsx'
import { SqliteRepoProvider } from '@/context/sqliteRepo.tsx'
import { FEATURE_SQLITE_BACKEND } from '@/config/featureFlags'

// Todo remember why I need this something about version mismatch/having implied react in custom blocks
window.React = React
window.ReactDOM = ReactDOM

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<SuspenseFallback/>}>
      <Login>
        <StorageProvider>
          {FEATURE_SQLITE_BACKEND ? (
            <SqliteRepoProvider>
              <RepoProvider>
                <Suspense fallback={<SuspenseFallback/>}>
                  <App/>
                </Suspense>
              </RepoProvider>
            </SqliteRepoProvider>
          ) : (
            <RepoProvider>
              <Suspense fallback={<SuspenseFallback/>}>
                <App/>
              </Suspense>
            </RepoProvider>
          )}
        </StorageProvider>
      </Login>
    </Suspense>
  </StrictMode>,
)
