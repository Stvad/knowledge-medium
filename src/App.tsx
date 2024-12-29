import { useState, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { ErrorBoundary } from 'react-error-boundary';
import { Editor } from '@monaco-editor/react';
import { useDynamicComponent } from './hooks/useDynamicComponent';
import {Block} from './types.ts'
import {BlockProperties} from './components/BlockProperties.tsx'


function FallbackComponent({ error }: { error: Error }) {
    return <div>Something went wrong: {error.message}</div>;
}

function DynamicBlockRenderer({ code }: { code: string }) {
    const { DynamicComp, error } = useDynamicComponent(code);

    if (error) {
        return <div className="error">Error: {error.message}</div>;
    }

    return (
        <ErrorBoundary FallbackComponent={FallbackComponent}>
            {DynamicComp && <DynamicComp />}
        </ErrorBoundary>
    );
}

function BlockComponent({ 
    block, 
    onUpdate, 
    onDelete,
    onIndent,
    onUnindent 
}: { 
    block: Block; 
    onUpdate: (block: Block) => void;
    onDelete: () => void;
    onIndent: () => void;
    onUnindent: () => void;
}) {
    const [isEditing, setIsEditing] = useState(false);
    const [showProperties, setShowProperties] = useState(false);

    const handleContentChange = (newContent: string) => {
        onUpdate({
            ...block,
            content: newContent,
        });
    };

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
            onDelete();            } else if (e.key === 'Tab') {
                e.preventDefault();
                if (e.shiftKey) {
                    onUnindent();
                } else {
                    onIndent();
                }
            }
    };

    const blockClass = block.properties.type === 'custom' ? 'block custom-block' : 'block';
    const contentEditor = block.properties.type === 'custom' ? (
        isEditing ? (
            <div>
                <Editor
                    height="200px"
                    defaultLanguage="typescript"
                    defaultValue={block.content}
                    onChange={(value) => {
                        if (value !== undefined) {
                            handleContentChange(value);
                        }
                    }}
                    options={{
                        minimap: { enabled: false },
                        fontSize: 14,
                    }}
                />
                <button onClick={() => setIsEditing(false)}>Done</button>
            </div>
        ) : (
            <div className="block-content">
                <DynamicBlockRenderer code={block.content} />
            </div>
        )
    ) : (
        <textarea
            value={block.content}
            onChange={(e) => handleContentChange(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={Math.min(5, block.content.split('\n').length)}
            style={{
                width: '100%',
                resize: 'vertical',
                minHeight: '1.5em',
                background: 'transparent',
                border: '1px solid #444',
                color: 'inherit',
                padding: '4px 8px',
                margin: '2px 0',
                borderRadius: '4px',
                boxSizing: 'border-box',
                fontFamily: 'inherit',
                fontSize: 'inherit',
            }}
        />
    );

    return (
        <div className={blockClass}>
            <div className="block-actions">
                {block.properties.type === 'custom' && (
                    <button onClick={() => setIsEditing(!isEditing)}>
                        {isEditing ? 'Done' : 'Edit'}
                    </button>
                )}
                <button onClick={() => setShowProperties(!showProperties)}>
                    {showProperties ? 'Hide Props' : 'Show Props'}
                </button>
                <button onClick={onDelete}>Delete</button>
            </div>
            {contentEditor}
            <BlockProperties
                properties={block.properties}
                show={showProperties}
                onChange={(newProps) => {
                    onUpdate({
                        ...block,
                        properties: newProps,
                    });
                }}
            />
            {block.children.map((child) => (
                <BlockComponent
                    key={child.id}
                    block={child}
                    onUpdate={(updatedChild) => {
                        onUpdate({
                            ...block,
                            children: block.children.map((c) =>
                                c.id === updatedChild.id ? updatedChild : c
                            ),
                        });
                    }}
                    onDelete={() => {
                        onUpdate({
                            ...block,
                            children: block.children.filter(c => c.id !== child.id)
                        });
                    }}
                    onIndent={() => {
                        const newBlocks = moveBlock([block], child.id, 'indent');
                        onUpdate(newBlocks[0]);
                    }}
                    onUnindent={() => {
                        const newBlocks = moveBlock([block], child.id, 'unindent');
                        onUpdate(newBlocks[0]);
                    }}
                />
            ))}
        </div>
    );
}

// Helper functions for block operations
function removeBlock(blocks: Block[], idToRemove: string): Block[] {
    return blocks.filter(block => block.id !== idToRemove)
        .map(block => ({
            ...block,
            children: removeBlock(block.children, idToRemove)
        }));
}

function findParentBlock(blocks: Block[], childId: string): Block | null {
    for (const block of blocks) {
        if (block.children.some(child => child.id === childId)) {
            return block;
        }
        const parent = findParentBlock(block.children, childId);
        if (parent) {
            return parent;
        }
    }
    return null;
}

function moveBlock(blocks: Block[], blockId: string, direction: 'indent' | 'unindent'): Block[] {
    if (direction === 'indent') {
        return blocks.map(block => {
            const blockIndex = block.children.findIndex(child => child.id === blockId);
            if (blockIndex > 0) {
                // Move the block to the previous sibling's children
                const prevSibling = block.children[blockIndex - 1];
                const currentBlock = block.children[blockIndex];
                return {
                    ...block,
                    children: [
                        ...block.children.slice(0, blockIndex - 1),
                        {
                            ...prevSibling,
                            children: [...prevSibling.children, currentBlock]
                        },
                        ...block.children.slice(blockIndex + 1)
                    ]
                };
            }
            return {
                ...block,
                children: block.children.map(child => ({
                    ...child,
                    children: moveBlock(child.children, blockId, direction)
                }))
            };
        });
    } else {
        // Unindent: Move the block to its parent's siblings
        const parent = findParentBlock(blocks, blockId);
        if (!parent) return blocks;

        const blockToMove = parent.children.find(child => child.id === blockId)!;
        const parentParent = findParentBlock(blocks, parent.id);
        
        if (!parentParent) {
            // Move to root level
            return [...blocks.filter(b => b.id !== blockId), blockToMove];
        }

        const parentIndex = parentParent.children.findIndex(child => child.id === parent.id);
        return blocks.map(block => {
            if (block.id === parentParent.id) {
                return {
                    ...block,
                    children: [
                        ...block.children.slice(0, parentIndex + 1),
                        blockToMove,
                        ...block.children.slice(parentIndex + 1)
                    ]
                };
            }
            return {
                ...block,
                children: block.children.map(child => ({
                    ...child,
                    children: removeBlock(child.children, blockId)
                }))
            };
        });
    }
}

function App() {
    const [blocks, setBlocks] = useState<Block[]>(() => {
        const savedBlocks = localStorage.getItem('blocks');
        if (savedBlocks) {
            return JSON.parse(savedBlocks);
        }
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
                    id: uuidv4(),
                    content: `
import React from 'react'

export default function CustomBlock() {
    const [count, setCount] = React.useState(0)
    
    return <div style={{ color: "green" }}>I am a custom block!
       <div>
                <button onClick={() => setCount(c => c - 1)}>-</button>
                <span style={{margin: '0 10px'}}>{count}</span>
                <button onClick={() => setCount(c => c + 1)}>+</button>
            </div> 
    </div>
}`,
                    properties: { type: 'custom' },
                    children: [],
                },
            ],
        }];
    });

    // Save to localStorage whenever blocks change
    useEffect(() => {
        localStorage.setItem('blocks', JSON.stringify(blocks));
    }, [blocks]);

    return (
        <div style={{ padding: '1rem' }}>
            <h1>Workflowy-like Editor with Dynamic Blocks</h1>
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
                />
            ))}
        </div>
    );
}

export default App;
