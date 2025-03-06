import { BlockRendererProps, BlockRenderer } from '@/types.ts'
import { BlockProperties } from '../BlockProperties.tsx'
import { BlockChildren } from '../BlockComponent.tsx'
import { Button } from '../ui/button.tsx'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible.tsx'
import { useIsEditing } from '@/data/properties.ts'
import { MarkdownContentRenderer } from '@/components/renderer/MarkdownContentRenderer.tsx'
import { TextAreaContentRenderer } from '@/components/renderer/TextAreaContentRenderer.tsx'
import { useEffect, KeyboardEvent, useRef, ClipboardEvent, useState } from 'react'
import { nextVisibleBlock, previousVisibleBlock, Block } from '@/data/block.ts'
import { useUIStateProperty } from '@/data/globalState'
import { useRepo } from '@/context/repo'
import { pasteMultilineText } from '@/utils/paste.ts'
import { useIsMobile } from '@/utils/react.tsx'
import { useHoverDirty } from 'react-use'
import { Breadcrumbs } from '@/components/Breadcrumbs.tsx'
import { GenerateRendererDialog } from '@/components/GenerateRendererDialog'
import { ErrorBoundary } from 'react-error-boundary'
import { FallbackComponent } from '@/components/util/error.tsx'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuPortal,
  ContextMenuSeparator, ContextMenuItem, ContextMenuContent,
} from '@/components/ui/context-menu.tsx'

interface DefaultBlockRendererProps extends BlockRendererProps {
  ContentRenderer?: BlockRenderer;
  EditContentRenderer?: BlockRenderer;
}

const copyBlockId = (block: Block) => {
  navigator.clipboard.writeText(block.id)
}

const zoomIn = (block: Block) => {
  if (typeof window !== 'undefined') {
    window.location.hash = block.id
  }
}

const BlockBullet = ({block}: { block: Block }) => {
  const blockData = block.use()
  const [isCollapsed] = block.useProperty<boolean>('system:collapsed', false)
  const [showProperties, setShowProperties] = block.useProperty<boolean>('system:showProperties', false)
  const [dialogOpen, setDialogOpen] = useState(false)
  
  if (!blockData) return null

  const hasChildren = blockData.childIds.length > 0
  
  const openGenerateRendererDialog = () => {
    setDialogOpen(true)
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <a
            href={`#${block.id}`}
            className="bullet-link flex items-center justify-center h-6 w-5"
            onClick={(e) => e.stopPropagation()}
          >
              <span
                className={`bullet h-1.5 w-1.5 rounded-full bg-muted-foreground/80 mx-auto` +
                  (hasChildren && isCollapsed ? 'bullet-with-children border-4 border-solid border-gray-200 box-content' : '')}/>
          </a>
        </ContextMenuTrigger>
        <ContextMenuPortal>
          <ContextMenuContent
            className="min-w-[160px] bg-background rounded-md p-1 shadow-md border border-border"
          >
            <ContextMenuItem
              className="flex cursor-pointer items-center px-2 py-1.5 text-sm outline-none hover:bg-muted rounded-sm"
              onSelect={() => copyBlockId(block)}
            >
              Copy ID
            </ContextMenuItem>
            <ContextMenuItem
              className="flex cursor-pointer items-center px-2 py-1.5 text-sm outline-none hover:bg-muted rounded-sm"
              onSelect={() => zoomIn(block)}
            >
              Zoom In
            </ContextMenuItem>
            <ContextMenuSeparator className="h-px bg-border my-1" />
            <ContextMenuItem
              className="flex cursor-pointer items-center px-2 py-1.5 text-sm outline-none hover:bg-muted rounded-sm"
              onSelect={openGenerateRendererDialog}
            >
              Generate Custom Renderer
            </ContextMenuItem>
            <ContextMenuItem
              className="flex cursor-pointer items-center px-2 py-1.5 text-sm outline-none hover:bg-muted rounded-sm"
              onSelect={() => setShowProperties(!showProperties)}
            >
              {showProperties ? 'Hide' : 'Show'} Properties
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenuPortal>
      </ContextMenu>
      
      <GenerateRendererDialog 
        block={block}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </>
  )
}


export function DefaultBlockRenderer(
  {
    block,
    ContentRenderer: DefaultContentRenderer = MarkdownContentRenderer,
    EditContentRenderer = TextAreaContentRenderer,
  }: DefaultBlockRendererProps,
) {
  const repo = useRepo()
  const [showProperties, setShowProperties] = block.useProperty<boolean>('system:showProperties', false)
  const [isEditing, setIsEditing] = useIsEditing()
  const [isCollapsed, setIsCollapsed] = block.useProperty<boolean>('system:collapsed', false)
  const [focusedBlockId, setFocusedBlockId] = useUIStateProperty<string>('focusedBlockId')
  const [topLevelBlockId] = useUIStateProperty<string>('topLevelBlockId')
  const [previousLoadTime] = useUIStateProperty<number>('previousLoadTime')
  const [seen, setSeen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const isMobile = useIsMobile()
  const blockData = block.use()
  // @ts-expect-error This seems like type bug
  const isHovering = useHoverDirty(ref)
  const isTopLevel = block.id === topLevelBlockId

  const inFocus = focusedBlockId === block.id
  if (inFocus && !seen) setSeen(true)

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

  if (!blockData) return null

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
      const result = hasUncollapsedChildren || isTopLevel ? await block.createChild({position: 'first'}) : await block.createSiblingBelow()
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
      const prevVisible = await previousVisibleBlock(block, topLevelBlockId!)
      void block.delete()
      if (prevVisible) setFocusedBlockId?.(prevVisible.id)
    }
  }

  const handlePaste = async (e: ClipboardEvent<HTMLDivElement>) => {
    if (!inFocus) return
    // todo this plausibly should be a global handler and not on the block

    e.preventDefault()
    const pastedText = e.clipboardData.getData('text/plain')

    const pasted = await pasteMultilineText(pastedText, block, repo)
    if (pasted[0]) {
      setFocusedBlockId(pasted[0].id)
    }
  }

  const ContentRenderer = isEditing && inFocus ? EditContentRenderer : DefaultContentRenderer
  const hasChildren = blockData?.childIds?.length > 0
  const updatedByOtherUser = blockData?.updatedByUserId !== block.currentUser.id && blockData.updateTime > previousLoadTime!
  const shouldShowUpdateIndicator = updatedByOtherUser && !seen

  const expandButton = () =>
    <CollapsibleTrigger
      asChild
      onClick={(e) => {
        e.stopPropagation()
        setIsCollapsed(!isCollapsed)
      }}>
      <Button
        variant="ghost"
        size="sm"
        className={`expand-collapse-button h-6 p-0 hover:bg-none transition-opacity 
          ${hasChildren && isHovering || isMobile ? 'opacity-100' : 'opacity-0'} 
          ${isMobile ? 'w-6' : 'w-3'}`
        }
      >
        <span className="text-lg text-muted-foreground">
          {isCollapsed ? '▸' : '▾'}
        </span>
      </Button>
    </CollapsibleTrigger>

  const blockControls = () =>
    <div className="block-controls flex items-center ">
      {!isMobile && expandButton()}
      <BlockBullet block={block}/>
    </div>

  const updateIndicator = () =>
    shouldShowUpdateIndicator && (
      <div className="absolute right-1 top-1 h-2 w-2 rounded-full bg-blue-400"
           title={`Updated by ${blockData.updatedByUserId} on ${new Date(blockData.updateTime).toLocaleString()}`}/>
    )

  return (
    <>
      {/*Todo it's not actually correct to use DefaultContentRenderer here, we need to call BlockComponent, but ask it to not render children? */}
      {isTopLevel && <div className="pt-2"><Breadcrumbs block={block} Renderer={DefaultContentRenderer}/></div>}

      <Collapsible
        open={!isCollapsed || isTopLevel}
        className={`tm-block relative flex items-start gap-1 ${isTopLevel ? 'top-level-block' : ''}`}
        data-block-id={block.id}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        ref={ref}
      >
        {!isTopLevel && blockControls()}

        <div className="block-body flex-grow relative flex flex-col">
          <div className={`flex flex-col rounded-sm ${inFocus ? 'bg-muted/50' : ''}`}>
            {updateIndicator()}

            <ErrorBoundary FallbackComponent={FallbackComponent}>
              <ContentRenderer block={block}/>
            </ErrorBoundary>

            {showProperties && (
              <BlockProperties block={block}/>
            )}
          </div>

          <CollapsibleContent>
            <BlockChildren block={block}/>
          </CollapsibleContent>
        </div>

        {hasChildren && isMobile && !isTopLevel && (
          <div className="absolute right-1 top-0 ">
            {expandButton()}
          </div>
        )}

      </Collapsible>
    </>
  )
}
