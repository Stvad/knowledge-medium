import {v4 as uuidv4} from 'uuid'
import {Block} from './types'
import {useRendererRegistry} from './hooks/useRendererRegistry'
import {useDocument} from '@automerge/automerge-repo-react-hooks'
import type {AutomergeUrl} from '@automerge/automerge-repo'
import {BlockComponent} from './components/BlockComponent.tsx'
import {RendererContext} from './context/RendererContext'

interface BlockDoc {
    blocks: Block[];
}

function App({docUrl}: { docUrl: AutomergeUrl }) {
    const [doc, changeDoc] = useDocument<{ state: string }>(docUrl)
    const parsedDoc = doc?.state ? JSON.parse(doc.state) as BlockDoc : null
    const blocks = parsedDoc?.blocks || getExampleBlocks() //todo empty
    console.log({blocks})
    const {registry: rendererRegistry, refreshRegistry} = useRendererRegistry(blocks)


    const updateBlocksState = async (newBlocks: Block[]) => {
        changeDoc(d => {
            d.state = JSON.stringify({blocks: newBlocks})
        })
        await refreshRegistry()
    }

    return (
        <RendererContext.Provider value={{registry: rendererRegistry, refreshRegistry}}>
            <div style={{padding: '1rem'}}>
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
                content: `
import React from 'react'

export default function CustomBlockRenderer({ block, onUpdate }) {
    return <div style={{ color: "green" }}>
        Custom renderer for: {block.content}
        <button onClick={() => onUpdate({ ...block, content: block.content + '!' })}>
            Add !
        </button>
    </div>;
}`,
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
