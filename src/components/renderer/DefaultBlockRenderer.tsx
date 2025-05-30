import { BlockRendererProps, BlockRenderer } from '@/types.ts'
import { BlockProperties } from '../BlockProperties.tsx'
import { BlockChildren } from '../BlockComponent.tsx'
import { Button } from '../ui/button.tsx'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible.tsx'
import {
  useIsEditing,
  showPropertiesProp,
  isCollapsedProp,
  topLevelBlockIdProp,
  previousLoadTimeProp,
  setFocusedBlockId,
} from '@/data/properties.ts'
import { MarkdownContentRenderer } from '@/components/renderer/MarkdownContentRenderer.tsx'
import { CodeMirrorContentRenderer } from '@/components/renderer/CodeMirrorContentRenderer.tsx'
import { useRef, ClipboardEvent, useState, useMemo, Ref, useEffect } from 'react'
import { Block, useData, usePropertyValue, useHasChildren } from '@/data/block.ts'
import { useUIStateProperty, useUserProperty, useUIStateBlock, useSelectionState, useInFocus } from '@/data/globalState'
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
  ContextMenuSeparator,
  ContextMenuItem,
  ContextMenuContent,
} from '@/components/ui/context-menu.tsx'
import { useNormalModeShortcuts } from '@/shortcuts/useActionContext.ts'
import { useBlockContext } from '@/context/block.tsx'
import { validateSelectionHierarchy, extendSelection } from '@/utils/selection'
import { isElementProperlyVisible } from '@/utils/dom.ts'

interface DefaultBlockRendererProps extends BlockRendererProps {
  ContentRenderer?: BlockRenderer;
  EditContentRenderer?: BlockRenderer;
}

/** Todo plausibly the following 2 things should be "actions" too
 * and would be nice to have the mechanism to invoke arbitrary action?
 *   e.g. have a custom event like 'trigger-action' with appropriate deps
 *
 * but like it's context independent? so when we fire an action like that, it shouldn't matter if it's "active"
 * bc we're providing deps?
 *
 * alternative interpretation is that we can just fire them by name and context, and then assume the deps are already there
 *  - nvm, here we're not changing selected block, so if we rely on pre-filled deps, we'll end pu with incorrect id
 *
 */

const copyBlockId = (block: Block) => {
  navigator.clipboard.writeText(block.id)
}

const zoomIn = (block: Block) => {
  if (typeof window !== 'undefined') {
    window.location.hash = block.id
  }
}

const BlockBullet = ({block}: { block: Block }) => {
  const [showProperties, setShowProperties] = usePropertyValue(block, showPropertiesProp)
  const [isCollapsed] = usePropertyValue(block, isCollapsedProp)

  const [dialogOpen, setDialogOpen] = useState(false)
  const {panelId} = useBlockContext()
  const hasChildren = useHasChildren(block)

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
            onClick={(e) => {
              e.stopPropagation()
              // todo this should work for any link, so it again calls for a more general navigation handler
              if (e.shiftKey) {
                e.preventDefault()
                window.dispatchEvent(new CustomEvent('open-panel', {
                  detail: {
                    blockId: block.id,
                    sourcePanelId: panelId,
                  },
                }))
              }
            }}
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
            <ContextMenuSeparator className="h-px bg-border my-1"/>
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

const ExpandButton = ({block, collapsibleRef}: { block: Block, collapsibleRef: Ref<HTMLDivElement | null> }) => {
  const [isCollapsed, setIsCollapsed] = usePropertyValue(block, isCollapsedProp)
  const isMobile = useIsMobile()
  const hasChildren = useHasChildren(block)

  // @ts-expect-error Seems like a library type error
  const isHovering = useHoverDirty(collapsibleRef)

  return <CollapsibleTrigger
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
}


const UpdateIndicator = ({block}: { block: Block }) => {
  const [seen, setSeen] = useState(false)
  const inFocus = useInFocus(block.id)
  const [previousLoadTime] = useUserProperty(previousLoadTimeProp)
  const blockData = useData(block)

  if (!blockData) return null

  if (inFocus && !seen) setSeen(true)

  const updatedByOtherUser = blockData?.updatedByUserId !== block.currentUser.id && blockData.updateTime > previousLoadTime!
  const shouldShowUpdateIndicator = updatedByOtherUser && !seen

  return shouldShowUpdateIndicator && (
    <div className="absolute right-1 top-1 h-2 w-2 rounded-full bg-blue-400"
         title={`Updated by ${blockData.updatedByUserId} on ${new Date(blockData.updateTime).toLocaleString()}`}/>
  )
}


export function DefaultBlockRenderer(
  {
    block,
    ContentRenderer: DefaultContentRenderer = MarkdownContentRenderer,
    EditContentRenderer = CodeMirrorContentRenderer,
  }: DefaultBlockRendererProps,
) {
  const repo = useRepo()
  const uiStateBlock = useUIStateBlock()
  const [isEditing] = useIsEditing()
  const [showProperties] = usePropertyValue(block, showPropertiesProp)
  const [isCollapsed] = usePropertyValue(block, isCollapsedProp)

  const [topLevelBlockId] = useUIStateProperty(topLevelBlockIdProp)
  const collapsibleRef = useRef<HTMLDivElement | null>(null)
  const contentContainerRef = useRef<HTMLDivElement | null>(null)
  const isMobile = useIsMobile()
  const isTopLevel = block.id === topLevelBlockId

  const [selectionState, setSelectionState] = useSelectionState()
  const isSelected = selectionState.selectedBlockIds.includes(block.id)

  const inFocus = useInFocus(block.id)
  const hasChildren = useHasChildren(block)

  const shortcutDependencies = useMemo(() => ({block}), [block])

  useNormalModeShortcuts(shortcutDependencies, inFocus && !isEditing && !isSelected)

  useEffect(() => {
    const element = contentContainerRef.current
    if (element && !isElementProperlyVisible(element)) element.scrollIntoView({behavior: 'instant', block: 'nearest'})
  }, [inFocus])

  const handlePaste = async (e: ClipboardEvent<HTMLDivElement>) => {
    if (!inFocus) return
    // todo this plausibly should be a global handler and not on the block

    e.preventDefault()
    const pastedText = e.clipboardData.getData('text/plain')

    const pasted = await pasteMultilineText(pastedText, block, repo)
    if (pasted[0]) {
      setFocusedBlockId(uiStateBlock, pasted[0].id)
    }
  }

  const ContentRenderer = isEditing && inFocus ? EditContentRenderer : DefaultContentRenderer

  const blockControls = () =>
    <div className="block-controls flex items-center ">
      {!isMobile && <ExpandButton block={block} collapsibleRef={collapsibleRef}/>}
      <BlockBullet block={block}/>
    </div>

  return (
    <div>
      {isTopLevel && <Breadcrumbs block={block}/>}

      <Collapsible
        open={!isCollapsed || isTopLevel}
        className={`tm-block relative flex items-start gap-1 ${isTopLevel ? 'top-level-block' : ''} ${isSelected ? 'bg-accent/80' : ''}`}
        data-block-id={block.id}
        tabIndex={0}
        onPaste={handlePaste}
        ref={collapsibleRef}
        onClick={async (e) => {
          e.preventDefault()
          e.stopPropagation()

          // Handle selection clicks
          if (e.ctrlKey || e.metaKey) {
            const newSelectedIds = isSelected
              ? selectionState.selectedBlockIds.filter(id => id !== block.id)
              : [...selectionState.selectedBlockIds, block.id]

            const validatedIds = await validateSelectionHierarchy(newSelectedIds, repo)

            setSelectionState({
              selectedBlockIds: validatedIds,
              anchorBlockId: validatedIds.length > 0
                ? (selectionState.anchorBlockId || block.id)
                : null,
            })
          } else if (e.shiftKey) {
            await extendSelection(block.id, uiStateBlock, repo)
          } else if (selectionState.selectedBlockIds.length > 0) {
            // Clear selection on regular click if there was a selection
            setSelectionState({
              selectedBlockIds: [],
              anchorBlockId: null,
            })
          }
          setFocusedBlockId(uiStateBlock, block.id)
        }}
      >
        {!isTopLevel && blockControls()}

        <div className="block-body flex-grow relative flex flex-col">
          <div className={`flex flex-col rounded-sm ${inFocus ? 'bg-muted/95' : ''}`}>
            <UpdateIndicator block={block}/>

            <div className={'block-content'} ref={contentContainerRef}>
              <ErrorBoundary FallbackComponent={FallbackComponent}>
                <ContentRenderer block={block}/>
              </ErrorBoundary>
            </div>

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
            {<ExpandButton block={block} collapsibleRef={collapsibleRef}/>}
          </div>
        )}

      </Collapsible>
    </div>
  )
}
