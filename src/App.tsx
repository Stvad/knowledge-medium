import { AutomergeUrl } from '@automerge/automerge-repo'
import { BlockComponent } from './components/BlockComponent'
import { BlockContextProvider } from '@/context/block.tsx'

const App = ({docId, safeMode}: { docId: AutomergeUrl, safeMode: boolean }) => {
  return (
    <BlockContextProvider initialValue={{topLevel: true, safeMode}}>
        <BlockComponent blockId={docId}/>
    </BlockContextProvider>
  )
}

export default App
