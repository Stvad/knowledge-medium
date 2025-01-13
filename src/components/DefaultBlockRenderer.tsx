import {useState, KeyboardEvent} from 'react'
import {BlockRendererProps, BlockRenderer} from '../types'
import {useRepo} from '@automerge/automerge-repo-react-hooks'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'

import {BlockProperties} from './BlockProperties'
import {createBlockDoc} from '../utils/block-operations.ts'
import {BlockChildren} from './BlockComponent.tsx'

export function MarkdownContentRenderer({ block }: BlockRendererProps) {
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

export function TextAreaContentRenderer({ block, changeBlock }: BlockRendererProps) {
    const repo = useRepo()
    const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            createBlockDoc(repo, { parentId: block.id })
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
        onChange={(e) => changeBlock((b => b.content = e.target.value))}
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
        changeBlock,
        ContentRenderer: DefaultContentRenderer = MarkdownContentRenderer,
        EditContentRenderer = TextAreaContentRenderer,
    }: DefaultBlockRendererProps,
) {
    const [showProperties, setShowProperties] = useState(false)
    const [isEditing, setIsEditing] = useState(false)

    const ContentRenderer = isEditing ? EditContentRenderer : DefaultContentRenderer

    const [isCollapsed, setIsCollapsed] = useState(false)
    const hasChildren = block.childIds.length > 0

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
            <div className={'block-body'}>
                <ContentRenderer block={block} changeBlock={changeBlock} />
                {showProperties && <BlockProperties
                    block={block}
                    changeProps={(changeFn) => changeBlock((b) => changeFn(b.properties))}
                />}
                {!isCollapsed && <BlockChildren block={block} />}
            </div>
        </div>
    )
}
