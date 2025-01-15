import { AutomergeUrl } from '@automerge/automerge-repo'
import { BlockComponent } from './components/BlockComponent'

const App = ({docId, safeMode}: { docId: AutomergeUrl, safeMode: boolean }) =>
  <BlockComponent blockId={docId} context={{topLevel: true, safeMode}}/>

export default App
