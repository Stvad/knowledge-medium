import { AutomergeUrl } from '@automerge/automerge-repo'
import { BlockComponent } from './components/BlockComponent'
import { BlockContext } from '@/context/block.tsx'

const App = ({docId, safeMode}: { docId: AutomergeUrl, safeMode: boolean }) => {
  return <BlockContext.Provider value={{topLevel: true, safeMode}}>
    <BlockComponent blockId={docId}/>
  </BlockContext.Provider>
}

export default App
