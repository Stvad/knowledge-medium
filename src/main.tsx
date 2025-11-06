import React, { StrictMode, Suspense } from 'react'
import ReactDOM from 'react-dom'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { RepoProvider } from '@/context/repo.tsx'
import { Login } from '@/components/Login.tsx'
import { SuspenseFallback } from '@/components/util/suspense.tsx'
import { StorageProvider } from '@/context/storage.tsx'

// Todo remember why I need this something about version mismatch/having implied react in custom blocks
window.React = React
window.ReactDOM = ReactDOM

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<SuspenseFallback/>}>
      <Login>
        <StorageProvider>
          <RepoProvider>
            <Suspense fallback={<SuspenseFallback/>}>
              <App/>
            </Suspense>
          </RepoProvider>
        </StorageProvider>
      </Login>
    </Suspense>
  </StrictMode>,
)
