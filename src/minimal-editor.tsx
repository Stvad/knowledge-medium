import { createRoot } from 'react-dom/client'
import { StrictMode } from 'react'
import { RepoProvider, useRepo } from '@/context/repo.tsx'
import { Login } from '@/components/Login.tsx'
import { useData } from '@/hooks/block.ts'

const docUrl = document.location.hash.substring(1) || null

function BasicEditor({url}: { url: string }) {
  const repo = useRepo()
  const block = repo.block(url)

  const doc = useData(block)
  if (!doc) return <div>Loading...</div>

  return (
    <textarea
      value={doc.content}
      onChange={(e) => {
        void block.setContent(e.target.value)
      }}
    />
  )
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

// Undo/redo: stage 1.6 strips the legacy UndoRedoManager. Re-implement
// on top of the new `command_events` audit log + `row_events` per-row
// snapshots in a follow-up — the data is in place, the wiring isn't.
