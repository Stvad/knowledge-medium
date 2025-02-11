import { UndoRedoManager } from '@onsetsoftware/automerge-repo-undo-redo'
import { repo as automergeRepo, Repo } from '@/data/repo'
import { createRoot } from 'react-dom/client'
import { StrictMode } from 'react'
import { isValidAutomergeUrl } from '@automerge/automerge-repo'
import { RepoProvider, useRepo } from '@/context/repo.tsx'

const undoRedoManager = new UndoRedoManager()
const repo = new Repo(automergeRepo, undoRedoManager)

const rootDocUrl = `${document.location.hash.substring(1)}`

const docUrl = isValidAutomergeUrl(rootDocUrl) ? rootDocUrl : null

const scope = 'minimal-editor'

function BasicEditor({url}: { url: string }) {
  const repo = useRepo()
  const block = repo.find(url)

  const doc = block.use()

  return <textarea value={doc?.content} onChange={(e) => {
    block.change(doc => {
      doc.content = e.target.value
    }, {scope})
  }}/>

}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RepoProvider value={repo}>
      {docUrl && <BasicEditor url={docUrl}/>}
    </RepoProvider>
  </StrictMode>,
)

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault()
    console.log('undo',  undoRedoManager.undo(scope))
  }

  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
    e.preventDefault()
    undoRedoManager.redo(scope)
  }
})

