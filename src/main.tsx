import React, { StrictMode } from 'react'
import ReactDOM from 'react-dom'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { isValidAutomergeUrl } from '@automerge/automerge-repo'
import { importState } from './utils/state.ts'
import { RepoProvider } from '@/context/repo.tsx'
import { getExampleBlocks } from '@/initData.ts'
import { Block, defaultChangeScope } from '@/data/block.ts'
import { repo, undoRedoManager } from '@/data/repoInstance.ts'

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

const rootDocUrl = `${document.location.hash.substring(1)}`
let handle: Block
if (isValidAutomergeUrl(rootDocUrl)) {
    handle = repo.find(rootDocUrl)
} else {
    const blockMap = await importState({blocks: getExampleBlocks()}, repo)
    handle = blockMap.values().next().value!
}
const docUrl = document.location.hash = handle.id
const isSafeMode = new URLSearchParams(window.location.search).has('safeMode')


createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <RepoProvider value={repo}>
            <App docId={docUrl} safeMode={isSafeMode} />
        </RepoProvider>
    </StrictMode>,
)
