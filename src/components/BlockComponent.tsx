import {Block, RendererRegistry} from '../types.ts'
import {useState} from 'react'
import {getRenderer} from '../hooks/useRendererRegistry.tsx'
import {moveBlock} from '../utils/block-operations.ts'

interface BlockChildrenParams {
    block: Block
    onUpdate: (block: Block) => void
    rendererRegistry: RendererRegistry
}

export const BlockChildren = ({block, onUpdate, rendererRegistry}: BlockChildrenParams) => {
    return <>
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
    </>
}

export function BlockComponent(
    {
        block,
        onUpdate,
        // onDelete,
        // onIndent,
        // onUnindent,
        rendererRegistry,
    }: {
        block: Block;
        onUpdate: (block: Block) => void;
        onDelete: () => void;
        onIndent: () => void;
        onUnindent: () => void;
        rendererRegistry: RendererRegistry;
    },
) {
    const [isEditing, setIsEditing] = useState(false)

    const Renderer = isEditing ? rendererRegistry.default : getRenderer(block, rendererRegistry)
    //todo maybe support 2 modes
    // full replaces - where all the things are handled by renderer
    // or partial, where there some common things the base compenent provides
    // like children, editing mode, the bullet thing in the future etc

    return (
        <div className={`block`}>
            <div className="block-actions">
                <button onClick={() => setIsEditing(!isEditing)}>
                    {isEditing ? 'Done' : 'Edit'}
                </button>
            </div>
            <Renderer block={block} onUpdate={onUpdate}/>
            <BlockChildren block={block} onUpdate={onUpdate} rendererRegistry={rendererRegistry}/>
        </div>
    )
}
