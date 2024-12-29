import  { useState } from 'react';
import { Block } from '../types';
import { BlockProperties } from './BlockProperties';

interface DefaultBlockRendererProps {
    block: Block;
    onUpdate: (block: Block) => void;
}

export function DefaultBlockRenderer({ block, onUpdate }: DefaultBlockRendererProps) {
    const [showProperties, setShowProperties] = useState(false);

    return (
        <>
            <div className="block-actions">
                <button onClick={() => setShowProperties(!showProperties)}>
                    {showProperties ? 'Hide Props' : 'Show Props'}
                </button>
            </div>
            <textarea
                value={block.content}
                onChange={(e) => onUpdate({ ...block, content: e.target.value })}
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
            <BlockProperties
                block={block}
                show={showProperties}
                onChange={(newProps) => onUpdate({ ...block, properties: newProps })}
            />
        </>
    );
}
