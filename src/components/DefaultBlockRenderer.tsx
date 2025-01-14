import {KeyboardEvent} from 'react'
import {BlockRendererProps, BlockRenderer} from '../types'

import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import {BlockProperties} from './BlockProperties'

import {BlockChildren} from './BlockComponent'

import {Button} from './ui/button'
import {Collapsible, CollapsibleContent, CollapsibleTrigger} from './ui/collapsible'
import {Block} from '@/data/block.ts'

export function MarkdownContentRenderer({block}: BlockRendererProps) {
  const blockData = block.use()
  const [_, setIsEditing] = useIsEditing(block)

  if (!blockData) return null

  return (
    <div
      className="min-h-[1.7em] whitespace-pre-wrap"
      onClick={() => setIsEditing(true)}
    >
      <Markdown remarkPlugins={[remarkGfm]}>
        {blockData.content}
      </Markdown>
    </div>
  )
}

export function TextAreaContentRenderer({block}: BlockRendererProps) {
  const blockData = block.use()
  const [_, setIsEditing] = useIsEditing(block)

  if (!blockData) return null

  const handleKeyDown = async (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      await block.createSiblingBelow({})
    } else if (e.key === 'Backspace' && blockData.content === '') {
      e.preventDefault()
      block.delete()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      if (e.shiftKey) {
        block.outdent()
      } else {
        block.indent()
      }
    } else if (e.key === 'ArrowUp' && e.metaKey && e.shiftKey) {
      e.preventDefault()
      block.changeOrder(-1)
    } else if (e.key === 'ArrowDown' && e.metaKey && e.shiftKey) {
      e.preventDefault()
      block.changeOrder(1)
    }
  }

  return (
    <textarea
      value={blockData.content}
      onChange={(e) => block.change(b => {
        b.content = e.target.value
      })}
      rows={Math.min(5, blockData.content.split('\n').length)}
      onKeyDown={handleKeyDown}
      className="w-full resize-none min-h-[1.7em] bg-transparent dark:bg-neutral-800 border-none p-0 font-inherit focus-visible:outline-none"
      onBlur={() => setIsEditing(false)}
    />
  )
}

interface DefaultBlockRendererProps extends BlockRendererProps {
  ContentRenderer?: BlockRenderer;
  EditContentRenderer?: BlockRenderer;
}

const useIsEditing = (block: Block) => {
  return block.useProperty<boolean>('system:isEditing', false)
}

export function DefaultBlockRenderer({
                                       block,
                                       ContentRenderer: DefaultContentRenderer = MarkdownContentRenderer,
                                       EditContentRenderer = TextAreaContentRenderer,
                                     }: DefaultBlockRendererProps) {
  const [showProperties, setShowProperties] = block.useProperty<boolean>('system:showProperties', false)
  const [isEditing] = useIsEditing(block)
  const [isCollapsed, setIsCollapsed] = block.useProperty<boolean>('system:collapsed', false)

  const blockData = block.use()
  if (!blockData) return null

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
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 mx-auto"/>
            )}
          </div>

          <div className="flex-grow relative flex flex-col">
            <ContentRenderer block={block}/>

            <div className="absolute right-0 top-0 opacity-0 transition-opacity group-hover:opacity-100 flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-6"
                onClick={() => setShowProperties(!showProperties)}
              >
                {showProperties ? '⚙️' : '⚙️'}
              </Button>
            </div>

            {showProperties && (
              <BlockProperties block={block}/>
            )}

            <CollapsibleContent>
              <BlockChildren block={block}/>
            </CollapsibleContent>
          </div>
        </div>
      </Collapsible>
    </div>
  )
}
