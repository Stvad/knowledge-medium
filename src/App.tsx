import { useRendererRegistry, RendererContext } from './hooks/useRendererRegistry'
import { AutomergeUrl } from '@automerge/automerge-repo'
import { BlockComponent } from './components/BlockComponent'

function App({ docId, safeMode }: { docId: AutomergeUrl, safeMode: boolean }) {
    const { registry: rendererRegistry, refreshRegistry } = useRendererRegistry([docId], safeMode)

    return (
        <RendererContext.Provider value={{ registry: rendererRegistry, refreshRegistry }}>
          <BlockComponent blockId={docId} context={{topLevel: true}} />
        </RendererContext.Provider>
    )
}

export default App
