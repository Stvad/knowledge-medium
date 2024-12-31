import {v4 as uuidv4} from 'uuid'
import {Block, BlockDoc} from './types'
import {useRendererRegistry, RendererContext} from './hooks/useRendererRegistry'
import {useDocument} from '@automerge/automerge-repo-react-hooks'
import {AutomergeUrl, updateText} from '@automerge/automerge-repo'
import {BlockComponent} from './components/BlockComponent.tsx'


function App({docUrl, safeMode}: { docUrl: AutomergeUrl, safeMode: boolean }) {
    const [doc, changeDoc] = useDocument<{ state: string }>(docUrl)
    const parsedDoc = doc?.state ? JSON.parse(doc.state) as BlockDoc : null
    const blocks = parsedDoc?.blocks || getExampleBlocks() //todo empty
    console.log({blocks})
    const {registry: rendererRegistry, refreshRegistry} = useRendererRegistry(blocks, safeMode)


    const updateBlocksState = async (newBlocks: Block[]) => {
        changeDoc(d => {
            // d.state = JSON.stringify({blocks: newBlocks})
            updateText(d, ['state'], JSON.stringify({blocks: newBlocks}))
        })
        await refreshRegistry()
    }

    const exportState = () => {
        if (!doc?.state) return
        const blob = new Blob([doc.state], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'document-state.json'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
    }

    const importState = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]
        if (!file) return

        const reader = new FileReader()
        reader.onload = (e) => {
            const content = e.target?.result as string
            try {
                // Validate JSON structure
                const parsed = JSON.parse(content) as BlockDoc
                if (!Array.isArray(parsed.blocks)) {
                    throw new Error('Invalid document structure')
                }
                
                changeDoc(d => {
                    d.state = content
                })
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
                            onChange={importState}
                            style={{ marginLeft: '8px' }}
                        />
                    </label>
                </div>
                {blocks.map((block) => (
                    <BlockComponent
                        key={block.id}
                        block={block}
                        onUpdate={(updatedBlock) => {
                            updateBlocksState(blocks.map((b) => (b.id === updatedBlock.id ? updatedBlock : b)))
                        }}
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
                ))}
            </div>
        </RendererContext.Provider>
    )
}

const getExampleBlocks = () => {
    const rendererId = uuidv4()
    return [{
        id: uuidv4(),
        content: 'Hello World\nThis is a multiline\ntext block',
        properties: {},
        children: [
            {
                id: uuidv4(),
                content: 'A normal text block\nwith multiple lines',
                properties: {},
                children: [],
            },
            {
                id: rendererId,
                content: `import { DefaultBlockRenderer } from "@/components/DefaultBlockRenderer"; 
 
function CustomBlockRenderer({ block, onUpdate }) {
    return <div style={{ color: "green" }}>
        Custom renderer for: {block.content}
        <button onClick={() => onUpdate({ ...block, content: block.content + '!' })}>
            Add !!
        </button>
    </div>
}


// By default renderer is responsible for rendering everything in the block (including controls/etc), 
// but we often want to just update the content of the block and leave everything else untouched, Here is an example of doing that
export default ({ block, onUpdate }) => <DefaultBlockRenderer block={block} onUpdate={onUpdate} ContentRenderer={CustomBlockRenderer}/> 
`,
                properties: {type: 'renderer'},
                children: [],
            },
            {
                id: uuidv4(),
                content: 'This block uses the custom renderer',
                properties: {renderer: rendererId},
                children: [],
            },
        ],
    }]
}

export default App
