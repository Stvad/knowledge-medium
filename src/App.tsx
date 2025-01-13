import { useRendererRegistry, RendererContext } from './hooks/useRendererRegistry'
import { AutomergeUrl } from '@automerge/automerge-repo'
import { BlockComponent } from './components/BlockComponent'
import { DocumentStateManagement } from './components/DocumentStateManagement'

function App({ docId, safeMode }: { docId: AutomergeUrl, safeMode: boolean }) {
    const { registry: rendererRegistry, refreshRegistry } = useRendererRegistry([docId], safeMode)

    return (
        <RendererContext.Provider value={{ registry: rendererRegistry, refreshRegistry }}>
            <div className="min-h-screen bg-background text-foreground">
                <div className="container mx-auto py-4">
                    <DocumentStateManagement docUrl={docId} />
                    <BlockComponent blockId={docId} />
                </div>
            </div>
        </RendererContext.Provider>
    )
}

export default App
