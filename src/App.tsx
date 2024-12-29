import { useState, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import {Block, RendererRegistry} from './types'
import { useRendererRegistry } from './hooks/useRendererRegistry';
import { removeBlock, moveBlock } from './utils/block-operations';

function BlockComponent({
    block,
    onUpdate,
    onDelete,
    onIndent,
    onUnindent,
    rendererRegistry
}: {
    block: Block;
    onUpdate: (block: Block) => void;
    onDelete: () => void;
    onIndent: () => void;
    onUnindent: () => void;
    rendererRegistry: RendererRegistry;
}) {
    const [isEditing, setIsEditing] = useState(false);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const newBlock: Block = {
                id: uuidv4(),
                content: '',
                properties: {},
                children: [],
            };
            onUpdate({
                ...block,
                children: [...block.children, newBlock],
            });
        } else if (e.key === 'Backspace' && block.content === '') {
            e.preventDefault();
            onDelete();
        } else if (e.key === 'Tab') {
            e.preventDefault();
            if (e.shiftKey) {
                onUnindent();
            } else {
                onIndent();
            }
        }
    };

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
// Determine which renderer to use
    const Renderer = getRenderer()
    console.log({ block, Renderer, rendererRegistry });

    return (
        <div className={`block ${block.properties.type === 'renderer' ? 'custom-block' : ''}`}>
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
    );
}

function App() {
    const [blocks, setBlocks] = useState<Block[]>(() => {
        const savedBlocks = localStorage.getItem('blocks')
        if (savedBlocks) return JSON.parse(savedBlocks)

        return exampleBlocks
    })

    const rendererRegistry = useRendererRegistry(blocks)

    useEffect(() => {
        localStorage.setItem('blocks', JSON.stringify(blocks))
    }, [blocks])

    return (
        <div style={{padding: '1rem'}}>
            {blocks.map((block) => (
                <BlockComponent
                    key={block.id}
                    block={block}
                    onUpdate={(updatedBlock) => {
                        setBlocks(blocks.map((b) => (b.id === updatedBlock.id ? updatedBlock : b)));
                    }}
                    onDelete={() => {
                        setBlocks(removeBlock(blocks, block.id));
                    }}
                    onIndent={() => {
                        setBlocks(moveBlock(blocks, block.id, 'indent'));
                    }}
                    onUnindent={() => {
                        setBlocks(moveBlock(blocks, block.id, 'unindent'));
                    }}
                    rendererRegistry={rendererRegistry}
                />
            ))}
        </div>
    );
}

const exampleBlocks = [{
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
            id: uuidv4(),
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
            properties: {renderer: '3'},
            children: [],
        },
    ],
}]


export default App;
