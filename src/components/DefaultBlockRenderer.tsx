import {useState, KeyboardEvent} from 'react'
import {Block, BlockRendererProps, BlockRenderer} from '../types'
import {BlockProperties} from './BlockProperties'
import {emptyBlock} from '../utils/block-operations.ts'
import {BlockChildren} from './BlockComponent.tsx'

function TextAreaContentRenderer({block, onUpdate}: BlockRendererProps) {
    const handleKeyDown = (e: KeyboardEvent) => {
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

    return <textarea
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
}

export function DefaultBlockRenderer(
    {
        block,
        onUpdate,
        ContentRenderer = TextAreaContentRenderer,
    }: BlockRendererProps & { ContentRenderer?: BlockRenderer },
) {
    const [showProperties, setShowProperties] = useState(false)

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
            <ContentRenderer block={block} onUpdate={onUpdate}/>
            {showProperties && <BlockProperties
                block={block}
                onChange={(newProps) => onUpdate({...block, properties: newProps})}
            />}
            <BlockChildren block={block} onUpdate={onUpdate}/>
        </>
    )
}
