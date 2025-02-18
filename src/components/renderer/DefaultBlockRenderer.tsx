import { BlockRendererProps, BlockRenderer } from '@/types.ts'
import { BlockProperties } from '../BlockProperties.tsx'
import { BlockChildren } from '../BlockComponent.tsx'
import { Button } from '../ui/button.tsx'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible.tsx'
import { useIsEditing } from '@/data/properties.ts'
import { MarkdownContentRenderer } from '@/components/renderer/MarkdownContentRenderer.tsx'
import { TextAreaContentRenderer } from '@/components/renderer/TextAreaContentRenderer.tsx'
import { useEffect, KeyboardEvent, useRef } from 'react'
import { nextVisibleBlock, previousVisibleBlock } from '@/data/block.ts'
import { useUIStateProperty } from '@/data/globalState'

interface DefaultBlockRendererProps extends BlockRendererProps {
  ContentRenderer?: BlockRenderer;
EditContentRenderer?: BlockRenderer;
}

export function DefaultBlockRenderer(
  {
    block,
    ContentRenderer: DefaultContentRenderer = MarkdownContentRenderer,
    EditContentRenderer = TextAreaContentRenderer,
  }: DefaultBlockRendererProps,
) {
  const [showProperties, setShowProperties] = block.useProperty<boolean>('system:showProperties', false)
  const [isEditing, setIsEditing] = useIsEditing()
  const [isCollapsed, setIsCollapsed] = block.useProperty<boolean>('system:collapsed', false)
  const [focusedBlockId, setFocusedBlockId] = useUIStateProperty<string>('focusedBlockId')
  const [topLevelBlockId] = useUIStateProperty<string>('topLevelBlockId')
  const ref = useRef<HTMLDivElement>(null)

  const handleKeyDown = async (e: KeyboardEvent<HTMLDivElement>) => {
    if (isEditing) return

    // todo shortcut customization/commands
    if (e.key === 'ArrowUp' && e.metaKey && e.shiftKey) {
      e.stopPropagation()
      block.changeOrder(-1)
    } else if (e.key === 'ArrowDown' && e.metaKey && e.shiftKey) {
      e.stopPropagation()
      block.changeOrder(1)
    } else if (e.key === 'ArrowDown' || e.key === 'k') {
      e.stopPropagation()
      e.preventDefault()

      const nextVisible = await nextVisibleBlock(block, topLevelBlockId!)
      if (nextVisible) setFocusedBlockId?.(nextVisible.id)
    } else if (e.key === 'ArrowUp' || e.key === 'h') {
      e.stopPropagation()
      e.preventDefault()
      const prevVisible = await previousVisibleBlock(block, topLevelBlockId!)
      if (prevVisible) setFocusedBlockId?.(prevVisible.id)
    } else if (e.key === 'i') {
      e.preventDefault()
      e.stopPropagation()
      setIsEditing(true)
    } else if (e.key === 'o') {
      e.preventDefault()
      e.stopPropagation()
      const hasUncollapsedChildren = ((blockData?.childIds.length ?? 0) > 0) && !isCollapsed
      const result = hasUncollapsedChildren ? await block.createChild({position: 'first'}) : await block.createSiblingBelow()
      if (result) {
        setFocusedBlockId(result.id)
        setIsEditing(true)
      }
    } else if (e.key === 't') {
      // not a deeply though through key mapping
      e.preventDefault()
      e.stopPropagation()
      setShowProperties(!showProperties)
    } else if (e.key === 'z' && !e.metaKey) { //todo better way to handle cases like this
      e.preventDefault()
      e.stopPropagation()
      setIsCollapsed(!isCollapsed)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      if (e.shiftKey) {
        block.outdent()
      } else {
        block.indent()
      }
    } else if (e.key === 'Delete') {
      e.preventDefault()
      e.stopPropagation()
      block.delete()
    }
  }

  const inFocus = focusedBlockId === block.id
  useEffect(() => {
    if (inFocus
      /**
       * todo, doing this so the edit mode stuff handles focus, but I don't love it, see if there is a better way
       * that doesn't create a logical dependency between the two
       */
      && !isEditing
    ) {
      ref.current?.focus()
    }
  }, [inFocus, isEditing])

  const blockData = block.use()
  if (!blockData) return null

  const ContentRenderer = isEditing && inFocus ? EditContentRenderer : DefaultContentRenderer
  const hasChildren = blockData?.childIds?.length > 0

  return (
    <div 
      className="group relative ml-4" 
      data-block-id={block.id} 
      tabIndex={0}
      onKeyDown={handleKeyDown}
      ref={ref}
    >
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
              <div className="flex items-center h-6 w-6 p-0">
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 mx-auto"/>
              </div>
            )}
          </div>

          <div className="flex-grow relative flex flex-col">
            <div className={`flex flex-col rounded-sm ${inFocus ? 'bg-muted/50' : ''}`}>
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
            </div>

            <CollapsibleContent>
              <BlockChildren block={block}/>
            </CollapsibleContent>
          </div>
        </div>
      </Collapsible>
    </div>
  )
}
