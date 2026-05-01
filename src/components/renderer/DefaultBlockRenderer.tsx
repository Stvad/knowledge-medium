import { BlockRendererProps, BlockRenderer } from '@/types.ts'
import { BlockProperties } from '../BlockProperties.tsx'
import { BlockChildren } from '../BlockComponent.tsx'
import { Button } from '../ui/button.tsx'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible.tsx'
import {
  showPropertiesProp,
  isCollapsedProp,
  topLevelBlockIdProp,
  previousLoadTimeProp,
  setFocusedBlockId,
} from '@/data/properties.ts'
import { MarkdownContentRenderer } from '@/components/renderer/MarkdownContentRenderer.tsx'
import { CodeMirrorContentRenderer } from '@/components/renderer/CodeMirrorContentRenderer.tsx'
import { useRef, ClipboardEvent, useState, useMemo, Ref, useEffect } from 'react'
import { Block } from '@/data/internals/block'
import {
  useUIStateProperty,
  useUserProperty,
  useUIStateBlock,
  useIsSelected,
  useInFocus,
  useInEditMode,
} from '@/data/globalState'
import { useRepo } from '@/context/repo'
import { buildAppHash } from '@/utils/routing.ts'
import { pasteMultilineText } from '@/utils/paste.ts'
import { useIsMobile } from '@/utils/react.tsx'
import { useHoverDirty } from 'react-use'
import { Breadcrumbs } from '@/components/Breadcrumbs.tsx'
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
import { useActionContextActivations } from '@/shortcuts/useActionContext.ts'
import { useBlockContext } from '@/context/block.tsx'
import { isElementProperlyVisible } from '@/utils/dom.ts'
import { useHasChildren, usePropertyValue, useData } from '@/hooks/block.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import {
  blockChildrenFooterFacet,
  blockClickHandlersFacet,
  blockContentDecoratorsFacet,
  blockContentRendererFacet,
  blockContentSurfacePropsFacet,
  shortcutSurfaceActivationsFacet,
} from '@/extensions/blockInteraction.ts'
import { BlockInteractionProvider } from '@/extensions/BlockInteractionProvider.tsx'

interface DefaultBlockRendererProps extends BlockRendererProps {
  ContentRenderer?: BlockRenderer;
  EditContentRenderer?: BlockRenderer;
  ChildrenRenderer?: BlockRenderer;
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

const copyBlockRef = (block: Block) => {
  navigator.clipboard.writeText(`((${block.id}))`)
}

const copyBlockEmbed = (block: Block) => {
  navigator.clipboard.writeText(`!((${block.id}))`)
}

const zoomIn = (block: Block, workspaceId: string) => {
  if (typeof window !== 'undefined') {
    window.location.hash = buildAppHash(workspaceId, block.id)
  }
}

/** Static bullet visual — pure markup, no link/menu/data dependency.
 *  Exported so LazyBlockComponent can reuse the exact same dot in its
 *  placeholder, keeping placeholder layout aligned with mounted blocks. */
export function BulletDot({withChildrenIndicator = false}: { withChildrenIndicator?: boolean }) {
  return (
    <span
      className={`bullet h-1.5 w-1.5 rounded-full bg-muted-foreground/80 mx-auto` +
        (withChildrenIndicator ? 'bullet-with-children border-4 border-solid border-gray-200 box-content' : '')}/>
  )
}

const BlockBullet = ({block}: { block: Block }) => {
  const repo = useRepo()
  const [showProperties, setShowProperties] = usePropertyValue(block, showPropertiesProp)
  const [isCollapsed] = usePropertyValue(block, isCollapsedProp)

  const {panelId} = useBlockContext()
  const hasChildren = useHasChildren(block)

  // App.tsx's bootstrap sets activeWorkspaceId before any block renders, so
  // the non-null assertion is the contract — not a defensive fallback.
  const workspaceId = repo.activeWorkspaceId!

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <a
          href={buildAppHash(workspaceId, block.id)}
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
          <BulletDot withChildrenIndicator={hasChildren && isCollapsed}/>
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
            onSelect={() => copyBlockRef(block)}
          >
            Copy Block Ref
          </ContextMenuItem>
          <ContextMenuItem
            className="flex cursor-pointer items-center px-2 py-1.5 text-sm outline-none hover:bg-muted rounded-sm"
            onSelect={() => copyBlockEmbed(block)}
          >
            Copy Block Embed
          </ContextMenuItem>
          <ContextMenuItem
            className="flex cursor-pointer items-center px-2 py-1.5 text-sm outline-none hover:bg-muted rounded-sm"
            onSelect={() => zoomIn(block, workspaceId)}
          >
            Zoom In
          </ContextMenuItem>
          <ContextMenuSeparator className="h-px bg-border my-1"/>
          <ContextMenuItem
            className="flex cursor-pointer items-center px-2 py-1.5 text-sm outline-none hover:bg-muted rounded-sm"
            onSelect={() => setShowProperties(!showProperties)}
          >
            {showProperties ? 'Hide' : 'Show'} Properties
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenuPortal>
    </ContextMenu>
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

  useEffect(() => {
    if (inFocus && !seen) {
      setSeen(true)
    }
  }, [inFocus, seen])

  if (!blockData) return null

  const updatedByOtherUser = blockData?.updatedBy !== block.repo.user.id && blockData.updatedAt > (previousLoadTime ?? 0)
  const shouldShowUpdateIndicator = updatedByOtherUser && !seen

  return shouldShowUpdateIndicator && (
    <div className="absolute right-1 top-1 h-2 w-2 rounded-full bg-blue-400"
         title={`Updated by ${blockData.updatedBy} on ${new Date(blockData.updatedAt).toLocaleString()}`}/>
  )
}


export function DefaultBlockRenderer(
  {
    block,
    ContentRenderer: DefaultContentRenderer = MarkdownContentRenderer,
    EditContentRenderer = CodeMirrorContentRenderer,
    ChildrenRenderer = BlockChildren,
  }: DefaultBlockRendererProps,
) {
  const repo = useRepo()
  const runtime = useAppRuntime()
  const blockContext = useBlockContext()
  const uiStateBlock = useUIStateBlock()
  const inEditMode = useInEditMode(block.id)
  const [showProperties] = usePropertyValue(block, showPropertiesProp)
  const [isCollapsed] = usePropertyValue(block, isCollapsedProp)

  const [topLevelBlockId] = useUIStateProperty(topLevelBlockIdProp)
  const collapsibleRef = useRef<HTMLDivElement | null>(null)
  const contentContainerRef = useRef<HTMLDivElement | null>(null)
  const isMobile = useIsMobile()
  const isTopLevel = block.id === topLevelBlockId

  const isSelected = useIsSelected(block.id)
  const inFocus = useInFocus(block.id)
  const hasChildren = useHasChildren(block)

  const blockInteractionContext = useMemo(() => ({
    block,
    repo,
    uiStateBlock,
    topLevelBlockId,
    inFocus,
    inEditMode,
    isSelected,
    isTopLevel,
    blockContext,
    contentRenderers: [
      {
        id: 'primary',
        renderer: DefaultContentRenderer,
      },
      {
        id: 'secondary',
        renderer: EditContentRenderer,
      },
    ],
  }), [
    block,
    repo,
    uiStateBlock,
    topLevelBlockId,
    inFocus,
    inEditMode,
    isSelected,
    isTopLevel,
    blockContext,
    DefaultContentRenderer,
    EditContentRenderer,
  ])

  const resolveBlockContentRenderer = runtime.read(blockContentRendererFacet)
  const baseContentRenderer =
    resolveBlockContentRenderer(blockInteractionContext) ?? DefaultContentRenderer
  const decorateContent = runtime.read(blockContentDecoratorsFacet)
  const ContentRenderer = useMemo(
    () => decorateContent(blockInteractionContext, baseContentRenderer),
    [decorateContent, blockInteractionContext, baseContentRenderer],
  )
  const resolveBlockClickHandler = runtime.read(blockClickHandlersFacet)
  const handleBlockClick = resolveBlockClickHandler(blockInteractionContext)
  const resolveContentSurfaceProps = runtime.read(blockContentSurfacePropsFacet)
  const contentSurfaceProps = useMemo(
    () => resolveContentSurfaceProps(blockInteractionContext),
    [blockInteractionContext, resolveContentSurfaceProps],
  )
  const resolveShortcutActivations = runtime.read(shortcutSurfaceActivationsFacet)
  const shortcutActivations = useMemo(
    () => resolveShortcutActivations({
      ...blockInteractionContext,
      surface: 'block',
    }),
    [blockInteractionContext, resolveShortcutActivations],
  )
  const resolveChildrenFooterSections = runtime.read(blockChildrenFooterFacet)
  const childrenFooterSections = useMemo(
    () => resolveChildrenFooterSections(blockInteractionContext),
    [blockInteractionContext, resolveChildrenFooterSections],
  )

  useActionContextActivations(shortcutActivations)

  useEffect(() => {
    if (!inFocus) return
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
        data-editing={inEditMode ? 'true' : 'false'}
        data-block-id={block.id}
        tabIndex={0}
        onPaste={handlePaste}
        ref={collapsibleRef}
        onClick={(event) => {
          void handleBlockClick?.(event)
        }}
      >
        {!isTopLevel && blockControls()}

        <div className="block-body flex-grow relative flex flex-col">
          <div className={`flex flex-col rounded-sm ${inFocus ? 'bg-muted/95' : ''}`}>
            <UpdateIndicator block={block}/>

            <div
              {...contentSurfaceProps}
              className={`block-content${contentSurfaceProps.className ? ` ${contentSurfaceProps.className}` : ''}`}
              ref={contentContainerRef}
            >
              <ErrorBoundary FallbackComponent={FallbackComponent}>
                <BlockInteractionProvider context={blockInteractionContext}>
                  {/* ContentRenderer comes from the registry-driven
                      decorate(blockContentDecoratorsFacet) memo above —
                      stable identity per blockInteractionContext, not a
                      fresh component each render. */}
                  {/* eslint-disable-next-line react-hooks/static-components */}
                  <ContentRenderer block={block}/>
                </BlockInteractionProvider>
              </ErrorBoundary>
            </div>

            {showProperties && (
              <BlockProperties block={block}/>
            )}
          </div>

          <CollapsibleContent>
            <ChildrenRenderer block={block}/>
          </CollapsibleContent>

          {childrenFooterSections.map((SectionRenderer, index) => (
            <ErrorBoundary key={index} FallbackComponent={FallbackComponent}>
              <SectionRenderer block={block}/>
            </ErrorBoundary>
          ))}
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
