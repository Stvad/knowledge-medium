import { BlockRendererProps, BlockRenderer } from '@/types.ts'
import { BlockProperties } from '../BlockProperties.tsx'
import { BlockChildren } from '../BlockComponent.tsx'
import { Button } from '../ui/button.tsx'
import { Collapsible, CollapsibleContent } from '../ui/collapsible.tsx'
import type { ComponentType } from 'react'
import {
  showPropertiesProp,
  isCollapsedProp,
  topLevelBlockIdProp,
  previousLoadTimeProp,
  setFocusedBlockId,
} from '@/data/properties.ts'
import { MarkdownContentRenderer } from '@/components/renderer/MarkdownContentRenderer.tsx'
import { CodeMirrorContentRenderer } from '@/components/renderer/CodeMirrorContentRenderer.tsx'
import { useRef, ClipboardEvent, useState, useMemo, useEffect } from 'react'
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
  blockHeaderFacet,
  blockLayoutFacet,
  shortcutSurfaceActivationsFacet,
  type BlockLayout,
  type BlockLayoutSlots,
  type BlockShellProps,
} from '@/extensions/blockInteraction.ts'
import { BlockInteractionProvider } from '@/extensions/BlockInteractionProvider.tsx'
import { useBlockInteractionContext } from '@/extensions/blockInteractionContext.tsx'

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

/** The expand/collapse button. Visibility is driven by the surrounding
 *  block wrapper's hover state via Tailwind group-hover (so the layout
 *  must apply `group/block` to whatever element should trigger the
 *  reveal). Decoupled from the Collapsible primitive — the underlying
 *  `isCollapsedProp` is the source of truth, and the layout's
 *  Collapsible (if any) reads it via its `open` prop. */
const ExpandButton = ({block}: { block: Block }) => {
  const [isCollapsed, setIsCollapsed] = usePropertyValue(block, isCollapsedProp)
  const isMobile = useIsMobile()
  const hasChildren = useHasChildren(block)

  // - mobile: always visible (touch UIs have no hover affordance)
  // - desktop with children: hidden until the parent block-group is hovered
  // - desktop leaf: invisible placeholder so layout doesn't reflow on
  //   children appearing/disappearing
  const visibilityClass = isMobile
    ? 'opacity-100'
    : hasChildren
      ? 'opacity-0 group-hover/block:opacity-100'
      : 'opacity-0'

  return (
    <Button
      variant="ghost"
      size="sm"
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        setIsCollapsed(!isCollapsed)
      }}
      className={`expand-collapse-button h-6 p-0 hover:bg-none transition-opacity ${visibilityClass} ${isMobile ? 'w-6' : 'w-3'}`}
    >
      <span className="text-lg text-muted-foreground">
        {isCollapsed ? '▸' : '▾'}
      </span>
    </Button>
  )
}


/** "Updated by other user" badge. Exported so it can be wired in as a
 *  default content decorator from `defaultRenderers`. */
export const UpdateIndicator = ({block}: { block: Block }) => {
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


/**
 * Default block layout — owns the entire shape of a block as rendered
 * (Collapsible wrapper, controls placement, body flow, focus highlight).
 * Plugins contribute alternatives via `blockLayoutFacet` for blocks they
 * want to redress (e.g. the video-player notes view).
 *
 * The `group/block` class is what makes hover-driven affordances like
 * `ExpandButton` show up — any layout that wants those affordances to
 * reveal on parent hover should mark its outer wrapper similarly.
 */
export const DefaultBlockLayout: BlockLayout = ({
  block,
  Content, Properties, Children, Footer,
  Controls, Header,
  shellProps,
}) => {
  const ctx = useBlockInteractionContext()
  const inFocus = ctx?.inFocus ?? false
  const isTopLevel = ctx?.isTopLevel ?? false
  const isSelected = ctx?.isSelected ?? false
  const [isCollapsed] = usePropertyValue(block, isCollapsedProp)

  return (
    <div>
      <Header/>

      <Collapsible
        {...shellProps}
        open={!isCollapsed || isTopLevel}
        className={`tm-block group/block relative flex items-start gap-1 ${isTopLevel ? 'top-level-block' : ''} ${isSelected ? 'bg-accent/80' : ''}`}
      >
        <Controls/>

        <div className="block-body flex-grow relative flex flex-col">
          <div className={`flex flex-col rounded-sm ${inFocus ? 'bg-muted/95' : ''}`}>
            <Content/>
            {Properties && <Properties/>}
          </div>

          <CollapsibleContent>
            <Children/>
          </CollapsibleContent>

          <Footer/>
        </div>
      </Collapsible>
    </div>
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
  const runtime = useAppRuntime()
  const blockContext = useBlockContext()
  const uiStateBlock = useUIStateBlock()
  const inEditMode = useInEditMode(block.id)
  const [showProperties] = usePropertyValue(block, showPropertiesProp)

  const [topLevelBlockId] = useUIStateProperty(topLevelBlockIdProp)
  const contentContainerRef = useRef<HTMLDivElement | null>(null)
  const isTopLevel = block.id === topLevelBlockId

  const isSelected = useIsSelected(block.id)
  const inFocus = useInFocus(block.id)

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
  const resolveHeaderSections = runtime.read(blockHeaderFacet)
  const headerSections = useMemo(
    () => resolveHeaderSections(blockInteractionContext),
    [blockInteractionContext, resolveHeaderSections],
  )
  const resolveBlockLayout = runtime.read(blockLayoutFacet)
  const Layout = useMemo(
    () => resolveBlockLayout(blockInteractionContext) ?? DefaultBlockLayout,
    [blockInteractionContext, resolveBlockLayout],
  )

  useActionContextActivations(shortcutActivations)

  useEffect(() => {
    if (!inFocus) return
    const element = contentContainerRef.current
    if (element && !isElementProperlyVisible(element)) element.scrollIntoView({behavior: 'instant', block: 'nearest'})
  }, [inFocus])

  // Stable across renders (latest closure picked up via closure capture
  // of `inFocus`/`block`/etc.; no need for useCallback because the
  // shellProps memo below captures handlePaste's identity for the layout's
  // benefit). pasteMultilineText is async; React swallows the promise via
  // the void cast in the wrapper.
  const handlePaste = async (e: ClipboardEvent<HTMLElement>) => {
    if (!inFocus) return
    // todo this plausibly should be a global handler and not on the block

    e.preventDefault()
    const pastedText = e.clipboardData.getData('text/plain')

    const pasted = await pasteMultilineText(pastedText, block, repo)
    if (pasted[0]) {
      setFocusedBlockId(uiStateBlock, pasted[0].id)
    }
  }

  // Content slot: the content surface div + its surface props + the
  // resolved/decorated ContentRenderer. Stable across renders unless one
  // of the underlying inputs (block, decorated renderer, surface props)
  // actually changed.
  const ContentSlot = useMemo<ComponentType>(() => {
    const Slot = () => (
      <div
        {...contentSurfaceProps}
        className={`block-content${contentSurfaceProps.className ? ` ${contentSurfaceProps.className}` : ''}`}
        ref={contentContainerRef}
      >
        <ErrorBoundary FallbackComponent={FallbackComponent}>
          {/* ContentRenderer comes from the registry-driven
              decorate(blockContentDecoratorsFacet) memo above —
              stable identity per blockInteractionContext, not a
              fresh component each render. */}
          {/* eslint-disable-next-line react-hooks/static-components */}
          <ContentRenderer block={block}/>
        </ErrorBoundary>
      </div>
    )
    Slot.displayName = 'BlockContentSlot'
    return Slot
  }, [block, ContentRenderer, contentSurfaceProps])

  const PropertiesSlot = useMemo<ComponentType | null>(() => {
    if (!showProperties) return null
    const Slot = () => <BlockProperties block={block}/>
    Slot.displayName = 'BlockPropertiesSlot'
    return Slot
  }, [block, showProperties])

  const ChildrenSlot = useMemo<ComponentType>(() => {
    const Slot = () => <BlockChildren block={block}/>
    Slot.displayName = 'BlockChildrenSlot'
    return Slot
  }, [block])

  const FooterSlot = useMemo<ComponentType>(() => {
    const Slot = () => (
      <>
        {childrenFooterSections.map((SectionRenderer, index) => (
          <ErrorBoundary key={index} FallbackComponent={FallbackComponent}>
            <SectionRenderer block={block}/>
          </ErrorBoundary>
        ))}
      </>
    )
    Slot.displayName = 'BlockFooterSlot'
    return Slot
  }, [block, childrenFooterSections])

  // Controls slot: bullet + expand affordances. Self-aware of top-level
  // (returns null since top-level blocks have no bullet) and of mobile
  // (renders the expand button as a top-right floater rather than inline
  // because mobile screens don't have desktop's horizontal real estate).
  const ControlsSlot = useMemo<ComponentType>(() => {
    const Slot = () => {
      const ictx = useBlockInteractionContext()
      const isMobile = useIsMobile()
      const hasChildren = useHasChildren(block)

      if (ictx?.isTopLevel) return null

      return (
        <>
          <div className="block-controls flex items-center">
            {!isMobile && <ExpandButton block={block}/>}
            <BlockBullet block={block}/>
          </div>
          {isMobile && hasChildren && (
            <div className="absolute right-1 top-0">
              <ExpandButton block={block}/>
            </div>
          )}
        </>
      )
    }
    Slot.displayName = 'BlockControlsSlot'
    return Slot
  }, [block])

  const HeaderSlot = useMemo<ComponentType>(() => {
    const Slot = () => (
      <>
        {headerSections.map((SectionRenderer, index) => (
          <ErrorBoundary key={index} FallbackComponent={FallbackComponent}>
            <SectionRenderer block={block}/>
          </ErrorBoundary>
        ))}
      </>
    )
    Slot.displayName = 'BlockHeaderSlot'
    return Slot
  }, [block, headerSections])

  const shellProps = useMemo<BlockShellProps>(() => ({
    'data-block-id': block.id,
    'data-editing': inEditMode ? 'true' : 'false',
    tabIndex: 0,
    onClick: handleBlockClick
      ? (event) => { void handleBlockClick(event) }
      : undefined,
    onPaste: (event) => { void handlePaste(event) },
  }), [block.id, inEditMode, handleBlockClick, handlePaste])

  const layoutSlots = useMemo<BlockLayoutSlots>(() => ({
    block,
    Content: ContentSlot,
    Properties: PropertiesSlot,
    Children: ChildrenSlot,
    Footer: FooterSlot,
    Controls: ControlsSlot,
    Header: HeaderSlot,
    shellProps,
  }), [
    block,
    ContentSlot, PropertiesSlot, ChildrenSlot, FooterSlot,
    ControlsSlot, HeaderSlot,
    shellProps,
  ])

  return (
    <BlockInteractionProvider context={blockInteractionContext}>
      {/* Layout is resolved from blockLayoutFacet — its identity is
          stable per blockInteractionContext (the resolver memo above),
          not a fresh component each render. */}
      {/* eslint-disable-next-line react-hooks/static-components */}
      <Layout {...layoutSlots}/>
    </BlockInteractionProvider>
  )
}
