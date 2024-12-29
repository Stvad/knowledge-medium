import  { useState } from 'react';
import { Editor } from '@monaco-editor/react';
import { Block } from '../types';
import { BlockProperties } from './BlockProperties';
import { DynamicBlockRenderer } from './DynamicBlockRenderer';

interface RendererBlockRendererProps {
    block: Block;
    onUpdate: (block: Block) => void;
}

export function RendererBlockRenderer({ block, onUpdate }: RendererBlockRendererProps) {
    const [isEditing, setIsEditing] = useState(true);
    const [showProperties, setShowProperties] = useState(false);

    return (
        <>
            <div className="block-actions">
                <button onClick={() => setIsEditing(!isEditing)}>
                    {isEditing ? 'Done' : 'Edit'}
                </button>
                <button onClick={() => setShowProperties(!showProperties)}>
                    {showProperties ? 'Hide Props' : 'Show Props'}
                </button>
                <button onClick={() => navigator.clipboard.writeText(block.id)}>
                    Copy ID
                </button>
            </div>
            {isEditing ? (
                <Editor
                    height="400px"
                    defaultLanguage="typescript"
                    defaultValue={block.content}
                    onChange={(value) => {
                        if (value !== undefined) {
                            onUpdate({ ...block, content: value });
                        }
                    }}
                    options={{
                        minimap: { enabled: false },
                        fontSize: 14,
                        scrollBeyondLastLine: false,
                    }}
                />
            ) : (
                <div className="block-content">
                    <DynamicBlockRenderer code={block.content} />
                </div>
            )}
            <BlockProperties
                block={block}
                show={showProperties}
                onChange={(newProps) => onUpdate({ ...block, properties: newProps })}
            />
        </>
    );
}
