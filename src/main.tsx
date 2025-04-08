import React, { StrictMode, Suspense } from 'react'
import ReactDOM from 'react-dom'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { RepoProvider } from '@/context/repo.tsx'
import { Login } from '@/components/Login.tsx'

// Todo remember why I need this something about version mismatch/having implied react in custom blocks
window.React = React
window.ReactDOM = ReactDOM

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<div>Loading...</div>}>
      <Login>
        <RepoProvider>
          <App/>
        </RepoProvider>
      </Login>
    </Suspense>
  </StrictMode>,
)
