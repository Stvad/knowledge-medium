import React, { StrictMode } from 'react'
import ReactDOM from 'react-dom'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { RepoProvider } from '@/context/repo.tsx'
import { defaultChangeScope } from '@/data/block.ts'
import { undoRedoManager } from '@/data/repoInstance.ts'
import { Login } from '@/components/Login.tsx'

// Todo remember why I need this something about version mismatch/having implied react in custom blocks
window.React = React
window.ReactDOM = ReactDOM

// todo better keybinding system
document.addEventListener('keydown', (e) => {
  // Check for Ctrl/Cmd + Z for undo
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault()
    // todo in textarea, plausibly just want to let the browser handle this/use default behavior
    undoRedoManager.undo(defaultChangeScope)
  }
  // Check for Ctrl/Cmd + Shift + Z or Ctrl/Cmd + Y for redo
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
    e.preventDefault()
    undoRedoManager.redo(defaultChangeScope)
  }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Login>
      <RepoProvider>
        <App/>
      </RepoProvider>
    </Login>
  </StrictMode>,
)
