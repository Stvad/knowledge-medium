import { AutomergeUrl } from '@automerge/automerge-repo'
import { BlockComponent } from './components/BlockComponent'
import { BlockContextProvider } from '@/context/block.tsx'
import { Suspense, use, useEffect } from 'react'
import { useUIStateProperty } from '@/data/globalState.ts'
import { useRepo } from '@automerge/automerge-repo-react-hooks'
import { getRootBlock, Block } from '@/data/block.ts'

// a clutch, mb a better way exists? we need this so it runs within the block context
function UIStateInitializer({ docId }: { docId: string }) {
  const [, setTopLevelBlockId] = useUIStateProperty('topLevelBlockId')
  useEffect(() => {
    setTopLevelBlockId(docId)
  }, [docId])
  return null
}

const App = ({docId, safeMode}: { docId: AutomergeUrl, safeMode: boolean }) => {
  // todo, remove this dependency/use my own repo

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
