import { BlockRendererProps, BlockRenderer } from '@/types.ts'
import { BlockProperties } from '../BlockProperties.tsx'
import { BlockChildren } from '../BlockComponent.tsx'
import { Button } from '../ui/button.tsx'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible.tsx'
import { useIsEditing } from '@/data/properties.ts'
import { MarkdownContentRenderer } from '@/components/renderer/MarkdownContentRenderer.tsx'
import { TextAreaContentRenderer } from '@/components/renderer/TextAreaContentRenderer.tsx'
import { useBlockContext } from '@/context/block.tsx'
import { useEffect } from 'react'

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
  const [isEditing, setIsEditing] = useIsEditing(block)
  const [isCollapsed, setIsCollapsed] = block.useProperty<boolean>('system:collapsed', false)
  const { focusedBlockId } = useBlockContext()

  useEffect(() => {
    //  todo I want to support focused but not editing
    if (focusedBlockId === block.id) {
      setIsEditing(true)
    }
  }, [focusedBlockId])

  const blockData = block.use()
  if (!blockData) return null

  const ContentRenderer = isEditing ? EditContentRenderer : DefaultContentRenderer
  const hasChildren = blockData?.childIds?.length > 0

  return (
    <div className="group relative ml-4" data-block-id={block.id} tabIndex={0}>
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
