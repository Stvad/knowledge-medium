import { useState, KeyboardEvent } from 'react'
import { BlockRendererProps, BlockRenderer } from '../types'

import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'

import { BlockProperties } from './BlockProperties'

import { BlockChildren } from './BlockComponent'

import { Button } from './ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible'

export function MarkdownContentRenderer({ block }: BlockRendererProps) {
  const blockData = block.use()
  if (!blockData) return null
  
  return (
    <Markdown remarkPlugins={[remarkGfm, remarkBreaks]}>
      {blockData.content}
    </Markdown>
  )
}

export function TextAreaContentRenderer({ block }: BlockRendererProps) {
  const blockData = block.use()
  if (!blockData) return null

  const handleKeyDown = async (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      await block.createSiblingBelow({})
    } else if (e.key === 'Backspace' && blockData.content === '') {
      e.preventDefault()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      if (e.shiftKey) {
        block.outdent()
      } else {
        block.indent()
      }
    }
  }

  return (
    <textarea
      value={blockData.content}
      onChange={(e) => block.change(b => { b.content = e.target.value })}
      rows={Math.min(5, blockData.content.split('\n').length)}
      onKeyDown={handleKeyDown}
      className="w-full resize-y min-h-[1.5em] bg-transparent dark:bg-neutral-800 border-none p-0 leading-normal font-inherit focus-visible:outline-none"
    />
  )
}

interface DefaultBlockRendererProps extends BlockRendererProps {
  ContentRenderer?: BlockRenderer;
  EditContentRenderer?: BlockRenderer;
}

export function DefaultBlockRenderer({
  block,
  ContentRenderer: DefaultContentRenderer = MarkdownContentRenderer,
  EditContentRenderer = TextAreaContentRenderer,
}: DefaultBlockRendererProps) {
  const [showProperties, setShowProperties] = useState(false)
  const [isEditing, setIsEditing] = useState(false)

  const blockData = block.use()
  if (!blockData) return null

  const isCollapsed = blockData.properties['system:collapsed'] === 'true'
  const setIsCollapsed = (collapsed: boolean) => block.change(b => b.properties['system:collapsed'] = collapsed ? 'true' : 'false')

  const ContentRenderer = isEditing ? EditContentRenderer : DefaultContentRenderer
  const hasChildren = blockData?.childIds?.length > 0

  return (
    <div className="group relative ml-4">
      <Collapsible open={!isCollapsed}>
        <div className="flex items-start gap-2">
          <div className="flex items-center h-6 w-6 -ml-6">
            {hasChildren ? (
              <CollapsibleTrigger asChild onClick={() => setIsCollapsed(!isCollapsed)}>
                <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
                  <span className="text-lg text-muted-foreground">{isCollapsed ? '▸' : '▾'}</span>
                </Button>
              </CollapsibleTrigger>
            ) : (
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 mx-auto" />
            )}
          </div>
          
          <div className="flex-grow">
            <div className="relative">
              <div className="min-h-[1.5em]">
                <ContentRenderer block={block} />
              </div>

              <div className="absolute right-0 top-0 opacity-0 transition-opacity group-hover:opacity-100 flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6"
                  onClick={() => setShowProperties(!showProperties)}
                >
                  {showProperties ? '⚙️' : '⚙️'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6"
                  onClick={() => setIsEditing(!isEditing)}
                >
                  {isEditing ? 'Done' : 'Edit'}
                </Button>
              </div>

              {showProperties && (
                <BlockProperties block={block} />
              )}

              <CollapsibleContent>
                <BlockChildren block={block} />
              </CollapsibleContent>
            </div>
          </div>
        </div>
      </Collapsible>
    </div>
  )
}
