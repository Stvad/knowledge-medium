import  { useState } from 'react';
import { Block } from '../types';
import { BlockProperties } from './BlockProperties';
import {emptyBlock} from '../utils/block-operations.ts'

interface DefaultBlockRendererProps {
    block: Block;
    onUpdate: (block: Block) => void;
}

export function DefaultBlockRenderer({ block, onUpdate }: DefaultBlockRendererProps) {
    const [showProperties, setShowProperties] = useState(false);

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
            // onDelete()
        } else if (e.key === 'Tab') {
            e.preventDefault()
            if (e.shiftKey) {
                // onUnindent()
            } else {
                // onIndent()
            }
        }
    }


    return (
        <>
            <div className="block-actions">
                <div className="block-actions">
                    <button onClick={() => setShowProperties(!showProperties)}>
                        {showProperties ? 'Hide Props' : 'Show Props'}
                    </button>
                    <button onClick={() => navigator.clipboard.writeText(block.id)}>
                        Copy ID
                    </button>
                </div>

            </div>
            <textarea
                value={block.content}
                onChange={(e) => onUpdate({...block, content: e.target.value})}
                rows={Math.min(5, block.content.split('\n').length)}
                onKeyDown={handleKeyDown}
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
            {showProperties && <BlockProperties
                block={block}
                onChange={(newProps) => onUpdate({ ...block, properties: newProps })}
            />}
        </>
    );
}
