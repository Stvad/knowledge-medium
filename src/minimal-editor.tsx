import { createRoot } from 'react-dom/client'
import { StrictMode } from 'react'
import { isValidAutomergeUrl } from '@automerge/automerge-repo'
import { RepoProvider, useRepo } from '@/context/repo.tsx'
import { Login } from '@/components/Login.tsx'
import { undoRedoManager } from '@/data/repoInstance.ts'
import { useData } from '@/data/block.ts'

const rootDocUrl = `${document.location.hash.substring(1)}`

const docUrl = isValidAutomergeUrl(rootDocUrl) ? rootDocUrl : null

const scope = 'minimal-editor'

function BasicEditor({url}: { url: string }) {
  const repo = useRepo()
  const block = repo.find(url)

  const doc = useData(block)

  return <textarea value={doc?.content} onChange={(e) => {
    block.change(doc => {
      doc.content = e.target.value
    }, {scope})
  }}/>

}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Login>
      <RepoProvider>
        {docUrl && <BasicEditor url={docUrl}/>}
      </RepoProvider>
    </Login>
  </StrictMode>,
)

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault()
    console.log('undo', undoRedoManager.undo(scope))
  }

  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
    e.preventDefault()
    undoRedoManager.redo(scope)
  }
})

