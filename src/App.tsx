import {Block} from './types'
import {useRendererRegistry, RendererContext} from './hooks/useRendererRegistry'
import {useRepo} from '@automerge/automerge-repo-react-hooks'
import {AutomergeUrl} from '@automerge/automerge-repo'
import {BlockComponent} from './components/BlockComponent.tsx'
import {importState} from './utils/state.ts'
import {getAllChildrenBlocks} from './utils/block-operations.ts'


function App({docUrl, safeMode}: { docUrl: AutomergeUrl, safeMode: boolean }) {
    const repo = useRepo()
    const {registry: rendererRegistry, refreshRegistry} = useRendererRegistry([docUrl], safeMode)

    const exportState = async () => {
        
        const blocks = await getAllChildrenBlocks(repo, docUrl)

        const exportData = { blocks }
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'document-state.json'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
    }

    const importFromFile = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]
        if (!file) return

        const reader = new FileReader()
        reader.onload = async(e) => {
            const content = e.target?.result as string
            try {
                // Validate JSON structure
                const state = JSON.parse(content) as { blocks: Block[] }
                if (!Array.isArray(state.blocks)) {
                    throw new Error('Invalid document structure')
                }
                
                // Create all block docs first and store in a map
                const blockDocsMap = await importState(state, repo)

                //navigate to the first block
                const firstBlock = blockDocsMap.get(state.blocks[0].id)
                if (firstBlock) {
                    window.location.href = `/#${firstBlock.url}`
                }
                
            } catch (err) {
                console.error('Failed to import document:', err)
                alert('Invalid document format')
            }
        }
        reader.readAsText(file)
    }

    return (
        <RendererContext.Provider value={{registry: rendererRegistry, refreshRegistry}}>
            <div className="page">
                <div className="document-controls">
                    <button onClick={exportState}>Export Document</button>
                    <label>
                        Import Document
                        <input 
                            type="file" 
                            accept=".json"
                            onChange={importFromFile}
                            style={{ marginLeft: '8px' }}
                        />
                    </label>
                </div>
                {/* {blocks.map((block) => ( */}
                    <BlockComponent
                        // key={block.id}
                        blockId={docUrl}
                        // onUpdate={(updatedBlock) => {
                            // updateBlocksState(blocks.map((b) => (b.id === updatedBlock.id ? updatedBlock : b)))
                        // }}
                        // onDelete={() => {
                        //     updateBlocksState(removeBlock(blocks, block.id))
                        // }}
                        // onIndent={() => {
                        //     updateBlocksState(moveBlock(blocks, block.id, 'indent'))
                        // }}
                        // onUnindent={() => {
                        //     updateBlocksState(moveBlock(blocks, block.id, 'unindent'))
                        // }}
                    />
                {/* ))} */}
            </div>
        </RendererContext.Provider>
    )
}

export default App
