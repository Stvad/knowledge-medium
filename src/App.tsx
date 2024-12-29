import {useState} from 'react'
import {v4 as uuidv4} from 'uuid'
import {Block, RendererRegistry} from './types'
import {useRendererRegistry} from './hooks/useRendererRegistry'
import {removeBlock, moveBlock} from './utils/block-operations'
import {useDocument} from '@automerge/automerge-repo-react-hooks'
import type {AutomergeUrl} from '@automerge/automerge-repo'

interface BlockDoc {
    blocks: Block[];
}

function BlockComponent({
                            block,
                            onUpdate,
                            onDelete,
                            onIndent,
                            onUnindent,
                            rendererRegistry,
                        }: {
    block: Block;
    onUpdate: (block: Block) => void;
    onDelete: () => void;
    onIndent: () => void;
    onUnindent: () => void;
    rendererRegistry: RendererRegistry;
}) {
    const [isEditing, setIsEditing] = useState(false)

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            const newBlock: Block = emptyBlock()
            onUpdate({
                ...block,
                children: [...block.children, newBlock],
            })
        } else if (e.key === 'Backspace' && block.content === '') {
            e.preventDefault()
            onDelete()
        } else if (e.key === 'Tab') {
            e.preventDefault()
            if (e.shiftKey) {
                onUnindent()
            } else {
                onIndent()
            }
        }
    }

    const getRenderer = () => {
        if (isEditing) return rendererRegistry.default
        let Renderer = rendererRegistry.default
        if (block.properties.type === 'renderer') {
            Renderer = rendererRegistry.renderer
        } else if (block.properties.renderer && rendererRegistry[block.properties.renderer]) {
            Renderer = rendererRegistry[block.properties.renderer]
        }
        return Renderer
    }

    const Renderer = getRenderer()

    return (
        <div className={`block ${block.properties.type === 'renderer' ? 'custom-block' : ''}`}
             onKeyDown={handleKeyDown}>
            <div className="block-actions">
                <button onClick={() => setIsEditing(!isEditing)}>
                    {isEditing ? 'Done' : 'Edit'}
                </button>
            </div>
            <Renderer block={block} onUpdate={onUpdate}/>
            {block.children.map((child) => (
                <BlockComponent
                    key={child.id}
                    block={child}
                    onUpdate={(updatedChild) => {
                        onUpdate({
                            ...block,
                            children: block.children.map((c) =>
                                c.id === updatedChild.id ? updatedChild : c,
                            ),
                        })
                    }}
                    onDelete={() => {
                        onUpdate({
                            ...block,
                            children: block.children.filter(c => c.id !== child.id),
                        })
                    }}
                    onIndent={() => {
                        const newBlocks = moveBlock([block], child.id, 'indent')
                        onUpdate(newBlocks[0])
                    }}
                    onUnindent={() => {
                        const newBlocks = moveBlock([block], child.id, 'unindent')
                        onUpdate(newBlocks[0])
                    }}
                    rendererRegistry={rendererRegistry}
                />
            ))}
        </div>
    )
}

const emptyBlock = () => {
    return {
        id: uuidv4(),
        content: '',
        properties: {},
        children: [],
    }
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
        <div style={{padding: '1rem'}}>
            {blocks.map((block) => (
                <BlockComponent
                    key={block.id}
                    block={block}
                    onUpdate={(updatedBlock) => {
                        updateBlocksState(blocks.map((b) => (b.id === updatedBlock.id ? updatedBlock : b)))
                    }}
                    onDelete={() => {
                        updateBlocksState(removeBlock(blocks, block.id))
                    }}
                    onIndent={() => {
                        updateBlocksState(moveBlock(blocks, block.id, 'indent'))
                    }}
                    onUnindent={() => {
                        updateBlocksState(moveBlock(blocks, block.id, 'unindent'))
                    }}
                    rendererRegistry={rendererRegistry}
                />
            ))}
        </div>
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
