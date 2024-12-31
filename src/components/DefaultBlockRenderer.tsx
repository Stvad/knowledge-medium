import {useState, KeyboardEvent} from 'react'
import {Block, BlockRendererProps, BlockRenderer} from '../types'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'

import {BlockProperties} from './BlockProperties'
import {emptyBlock} from '../utils/block-operations.ts'
import {BlockChildren} from './BlockComponent.tsx'

export function MarkdownContentRenderer({block}: BlockRendererProps) {
    return <div style={{
        padding: '4px 8px',
        margin: '2px 0',
    }}>
        <Markdown
            remarkPlugins={[remarkGfm, remarkBreaks]}
        >
            {block.content}
        </Markdown>
    </div>
}

export function TextAreaContentRenderer({block, onUpdate}: BlockRendererProps) {
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

interface DefaultBlockRendererProps extends BlockRendererProps {
    ContentRenderer?: BlockRenderer;
    EditContentRenderer?: BlockRenderer;
}

export function DefaultBlockRenderer(
    {
        block,
        onUpdate,
        ContentRenderer: DefaultContentRenderer = MarkdownContentRenderer,
        EditContentRenderer = TextAreaContentRenderer,
    }: DefaultBlockRendererProps,
) {
    const [showProperties, setShowProperties] = useState(false)
    const [isEditing, setIsEditing] = useState(false)

    const ContentRenderer = isEditing ? EditContentRenderer : DefaultContentRenderer

    const [isCollapsed, setIsCollapsed] = useState(false)
    const hasChildren = block.children.length > 0

    return (
        <div className={'block'}>
            <div className="block-actions">
                <button onClick={() => setShowProperties(!showProperties)}>
                    {showProperties ? 'Hide Props' : 'Show Props'}
                </button>
                <button onClick={() => navigator.clipboard.writeText(block.id)}>
                    Copy ID
                </button>
                <button onClick={() => setIsEditing(!isEditing)}>
                    {isEditing ? 'Done' : 'Edit'}
                </button>
            </div>

            <div className="block-controls">
                <span
                    className={`block-bullet ${hasChildren ? 'has-children' : ''}`}
                    onClick={() => hasChildren && setIsCollapsed(!isCollapsed)}
                >
                    {hasChildren ? (isCollapsed ? '▸' : '▾') : '•'}
                </span>
            </div>
            <div className={"block-body"}>
                <ContentRenderer block={block} onUpdate={onUpdate}/>
                {showProperties && <BlockProperties
                    block={block}
                    onChange={(newProps) => onUpdate({...block, properties: newProps})}
                />}
                {!isCollapsed && <BlockChildren block={block} onUpdate={onUpdate}/>}
            </div>
        </div>
    )
}
