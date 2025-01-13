import {useRendererRegistry, RendererContext} from './hooks/useRendererRegistry'
import {AutomergeUrl} from '@automerge/automerge-repo'
import {BlockComponent} from './components/BlockComponent.tsx'
import {DocumentStateManagement} from './components/DocumentStateManagement.tsx'

function App({docId, safeMode}: { docId: AutomergeUrl, safeMode: boolean }) {
    const {registry: rendererRegistry, refreshRegistry} = useRendererRegistry([docId], safeMode)

    return (
        <RendererContext.Provider value={{registry: rendererRegistry, refreshRegistry}}>
            <div className="page">
                <DocumentStateManagement docUrl={docId} />
                <BlockComponent blockId={docId} />
            </div>
        </RendererContext.Provider>
    )
}

export default App
