import { AutomergeUrl } from '@automerge/automerge-repo'
import { BlockComponent } from './components/BlockComponent'
import { BlockContextProvider } from '@/context/block.tsx'
import { Suspense, use, useEffect } from 'react'
import { useUIStateProperty } from '@/data/globalState.ts'
import { getRootBlock, Block } from '@/data/block.ts'
import { useRepo } from '@/context/repo.tsx'

// a clutch, mb a better way exists? we need this so it runs within the block context
function UIStateInitializer({ docId }: { docId: string }) {
  const [, setTopLevelBlockId] = useUIStateProperty('topLevelBlockId')
  useEffect(() => {
    setTopLevelBlockId(docId)
  }, [docId])
  return null
}

const App = ({docId, safeMode}: { docId: AutomergeUrl, safeMode: boolean }) => {

  const repo = useRepo()
  const rootBlock = use(getRootBlock(new Block(repo, docId)))

  return (
    <Suspense fallback={<div>Loading...</div>}>
      <BlockContextProvider initialValue={{rootBlockId: rootBlock.id, topLevel: true, safeMode}}>
        <UIStateInitializer docId={docId}/>
        <BlockComponent blockId={docId}/>
      </BlockContextProvider>
    </Suspense>
  )
}

export default App
