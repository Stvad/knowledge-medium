import { BlockRendererProps, BlockRenderer } from '@/types.js'
import { BlockProperties } from '../BlockProperties.tsx'
import { BlockChildren } from '../BlockComponent.tsx'
import { Button } from '../ui/button.tsx'
import { Collapsible, CollapsibleContent } from '../ui/collapsible.tsx'
import type { ComponentType, RefObject } from 'react'
import {
  focusBlock,
  showPropertiesProp,
  isCollapsedProp,
  topLevelBlockIdProp,
  typesProp,
} from '@/data/properties.js'
import { MarkdownContentRenderer } from '@/components/renderer/MarkdownContentRenderer.js'
import { CodeMirrorContentRenderer } from '@/components/renderer/CodeMirrorContentRenderer.js'
import { useRef, ClipboardEvent, useMemo } from 'react'
import { Block } from '../../data/block'
import {
  useUIStateProperty,
  useUIStateBlock,
  useIsSelected,
  useInEditMode,
} from '@/data/globalState'
import { useRepo } from '@/context/repo'
import { buildAppHash } from '@/utils/routing.js'
import { navigate, useOpenBlock } from '@/utils/navigation.js'
import { pasteMultilineText } from '@/utils/paste.js'
import { withMoveTransition } from '@/utils/viewTransition.js'
import { useIsMobile } from '@/utils/react.js'
import { ErrorBoundary } from 'react-error-boundary'
import { FallbackComponent } from '@/components/util/error.js'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuPortal,
  ContextMenuSeparator,
  ContextMenuItem,
  ContextMenuContent,
} from '@/components/ui/context-menu.js'
import { useBlockContext } from '@/context/block.js'
import { useHasChildren, usePropertyValue } from '@/hooks/block.js'
import { useIsFocalRender } from '@/hooks/useIsFocalRender.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { ExtensionRenderBoundary } from '@/extensions/ExtensionRenderBoundary.js'
import {
  blockChildrenFooterFacet,
  blockClickHandlersFacet,
  blockContentDecoratorsFacet,
  blockContentRendererFacet,
  blockContentSurfacePropsFacet,
  blockHeaderFacet,
  blockLayoutFacet,
  blockShellDecoratorsFacet,
  isInteractiveContentEvent,
  type BlockLayout,
  type BlockLayoutSlots,
  type BlockResolveContext,
  type BlockShellDecorator,
  type BlockShellState,
  type BlockShellProps,
} from '@/extensions/blockInteraction.js'
import { useShortcutSurfaceActivations } from '@/extensions/useShortcutSurfaceActivations.js'
import { isFocusedBlock } from '@/data/properties.js'

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

const zoomIn = (block: Block, workspaceId: string, panelId?: string) => {
  if (typeof window !== 'undefined') {
    navigate(block.repo, panelId
      ? {blockId: block.id, workspaceId, target: 'panel', panelId}
      : {blockId: block.id, workspaceId, target: 'active'})
  }
}

/** Static bullet visual — pure markup, no link/menu/data dependency.
 *  Exported so LazyBlockComponent can reuse the exact same dot in its
 *  placeholder, keeping placeholder layout aligned with mounted blocks. */
export function BulletDot({withChildrenIndicator = false}: { withChildrenIndicator?: boolean }) {
  return (
    <span
      className={`bullet h-1.5 w-1.5 rounded-full bg-muted-foreground/80 mx-auto` +
        (withChildrenIndicator ? 'bullet-with-children border-4 border-solid border-border box-content' : '')}/>
  )
}

const BlockBullet = ({block}: { block: Block }) => {
  const repo = useRepo()
  const {panelId} = useBlockContext()
  const [showProperties, setShowProperties] = usePropertyValue(block, showPropertiesProp)
  const [isCollapsed] = usePropertyValue(block, isCollapsedProp)

  const hasChildren = useHasChildren(block)

  // App.tsx's bootstrap sets activeWorkspaceId before any block renders, so
  // the non-null assertion is the contract — not a defensive fallback.
  const workspaceId = repo.activeWorkspaceId!
  const onClick = useOpenBlock({blockId: block.id, workspaceId})

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <a
          href={buildAppHash(workspaceId, block.id)}
          className="bullet-link flex items-center justify-center h-6 w-5"
          onClick={onClick}
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
            onSelect={() => zoomIn(block, workspaceId, panelId)}
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

  // On touch devices the synthesized `click` arrives after a small
  // delay and after `pointerup`/`touchend`; if anything between those
  // events reroutes focus or React unmounts/repaints the button, the
  // click can land on the underlying block-content and dispatch the
  // block click handler — dropping us into edit mode. Stopping
  // propagation on `pointerdown` blocks that path the moment the touch
  // is registered, before the synthetic click bubbles. The redundant
  // `onClick.stopPropagation` covers the desktop mouse path.
  const toggle = () => {
    void withMoveTransition(async () => {
      await setIsCollapsed(!isCollapsed)
    })
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      type="button"
      data-block-interaction="ignore"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        toggle()
      }}
      className={`expand-collapse-button p-0 hover:bg-none transition-opacity duration-200 ${visibilityClass} ${isMobile ? 'h-8 w-8' : 'h-6 w-3'}`}
    >
      <span className="text-lg text-muted-foreground">
        {isCollapsed ? '▸' : '▾'}
      </span>
    </Button>
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
  const isSelected = useIsSelected(block.id)
  const isTopLevel = useIsFocalRender(block)
  const [isCollapsed] = usePropertyValue(block, isCollapsedProp)
  const {className: shellClassName, ...collapsibleProps} = shellProps

  // No per-block `view-transition-name`. Tried it (commit b1bfa4ef,
  // reverted): the slide-between-positions effect was barely
  // perceptible vs. the root-level crossfade we already get from
  // `withMoveTransition`, and it introduced two real issues —
  //  - per-block snapshots are lifted into the document-root overlay,
  //    so a block scrolled under the (in-flow) app header briefly
  //    paints over it during the transition;
  //  - the default group animation crossfades old/new image pairs in
  //    parallel with the position morph, so move-up/down shows two
  //    overlapping copies of the same text mid-flight.
  // Both are inherent to per-element VTN matching in an unscoped
  // overlay; a future scoped-view-transitions or per-panel-rooted
  // setup could revisit. For now, the root-level crossfade is enough.

  return (
    <div>
      <Header/>

      <Collapsible
        {...collapsibleProps}
        open={!isCollapsed || isTopLevel}
        className={`tm-block group/block relative flex items-start gap-1 outline-none focus:outline-none focus-visible:outline-none ${isTopLevel ? 'top-level-block' : ''} ${isSelected ? 'bg-accent/80' : ''} ${shellClassName ?? ''}`}
      >
        <Controls/>

        <div className="block-body flex-grow relative flex flex-col">
          <div className="flex flex-col rounded-sm">
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

function BlockShellDecoratorStack({
  decorators,
  index = 0,
  resolveContext,
  shellRef,
  contentRef,
  state,
  ShellBody,
}: {
  decorators: readonly BlockShellDecorator[]
  index?: number
  resolveContext: BlockResolveContext
  shellRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  state: BlockShellState
  ShellBody: ComponentType<{state: BlockShellState}>
}) {
  const Decorator = decorators[index]
  if (!Decorator) return <ShellBody state={state}/>

  return (
    <ExtensionRenderBoundary>
      <Decorator
        resolveContext={resolveContext}
        shellRef={shellRef}
        contentRef={contentRef}
        state={state}
      >
        {nextState => (
          <BlockShellDecoratorStack
            decorators={decorators}
            index={index + 1}
            resolveContext={resolveContext}
            shellRef={shellRef}
            contentRef={contentRef}
            state={nextState}
            ShellBody={ShellBody}
          />
        )}
      </Decorator>
    </ExtensionRenderBoundary>
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
  const [types] = usePropertyValue(block, typesProp)

  const [topLevelBlockId] = useUIStateProperty(topLevelBlockIdProp)
  const shellRef = useRef<HTMLDivElement | null>(null)
  const contentContainerRef = useRef<HTMLDivElement | null>(null)
  const isTopLevel = useIsFocalRender(block)

  // Stable per-block resolver context — doesn't change on focus/edit/
  // selection toggles, so facet resolvers and the components they
  // produce keep stable identity. This is what stops UpdateIndicator
  // (and any other content decorator) from remounting on every click.
  const resolveContext = useMemo<BlockResolveContext>(() => ({
    block,
    repo,
    uiStateBlock,
    types,
    topLevelBlockId,
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
    types,
    topLevelBlockId,
    isTopLevel,
    blockContext,
    DefaultContentRenderer,
    EditContentRenderer,
  ])

  // Memoize on resolveContext so contributions that synthesize a fresh
  // component each call (e.g. plain-outliner's edit-mode dispatcher) don't
  // hand back a new identity every render and remount the entire content
  // subtree underneath. The runtime.read result is itself cached per
  // facet runtime, so the resolver function is already stable.
  const resolveBlockContentRenderer = runtime.read(blockContentRendererFacet)
  // Variant facet: contributions self-gate, last truthy variant wins —
  // matches the previous combineLastContributionResult semantics. When
  // nothing contributes, fall through to the host's primary renderer.
  const baseContentRenderer = useMemo(
    () =>
      resolveBlockContentRenderer(resolveContext).last?.render ?? DefaultContentRenderer,
    [resolveBlockContentRenderer, resolveContext, DefaultContentRenderer],
  )
  const decorateContent = runtime.read(blockContentDecoratorsFacet)
  const ContentRenderer = useMemo(
    () => decorateContent(resolveContext, baseContentRenderer),
    [decorateContent, resolveContext, baseContentRenderer],
  )
  const resolveBlockClickHandler = runtime.read(blockClickHandlersFacet)
  const handleBlockClick = useMemo(
    () => resolveBlockClickHandler(resolveContext),
    [resolveBlockClickHandler, resolveContext],
  )
  const resolveContentSurfaceProps = runtime.read(blockContentSurfacePropsFacet)
  const contentSurfaceProps = useMemo(
    () => resolveContentSurfaceProps(resolveContext),
    [resolveContext, resolveContentSurfaceProps],
  )
  const resolveChildrenFooterSections = runtime.read(blockChildrenFooterFacet)
  const childrenFooterSections = useMemo(
    () => resolveChildrenFooterSections(resolveContext),
    [resolveContext, resolveChildrenFooterSections],
  )
  const resolveHeaderSections = runtime.read(blockHeaderFacet)
  const headerSections = useMemo(
    () => resolveHeaderSections(resolveContext),
    [resolveContext, resolveHeaderSections],
  )
  const resolveBlockLayout = runtime.read(blockLayoutFacet)
  // Last-wins on the variant facet — same migration shape as content
  // renderer above. `DefaultBlockLayout` is the no-contribution fallback.
  const Layout = useMemo(
    () => resolveBlockLayout(resolveContext).last?.render ?? DefaultBlockLayout,
    [resolveContext, resolveBlockLayout],
  )
  const resolveBlockShellDecorators = runtime.read(blockShellDecoratorsFacet)
  const shellDecorators = useMemo(
    () => resolveBlockShellDecorators(resolveContext),
    [resolveBlockShellDecorators, resolveContext],
  )

  // Memoized on stable inputs so shellProps below doesn't churn on
  // focus toggles. The "is this block focused?" check reads live state
  // at fire time via `peekProperty`, not via the React `inFocus` prop —
  // capturing `inFocus` would tie this closure (and shellProps) to
  // reactive state, defeating the resolveContext stability split above.
  // todo this plausibly should be a global handler and not on the block
  const handlePaste = useMemo(
    () => async (e: ClipboardEvent<HTMLElement>) => {
      if (e.defaultPrevented || isInteractiveContentEvent(e)) return
      const renderScopeId = typeof blockContext.renderScopeId === 'string'
        ? blockContext.renderScopeId
        : undefined
      if (!isFocusedBlock(uiStateBlock, block.id, renderScopeId)) return

      e.preventDefault()
      const pastedText = e.clipboardData.getData('text/plain')

      const pasted = await pasteMultilineText(pastedText, block, repo)
      if (pasted[0]) {
        void focusBlock(uiStateBlock, pasted[0].id, {renderScopeId})
      }
    },
    [block, blockContext.renderScopeId, repo, uiStateBlock],
  )

  // Content slot: the content surface div + its surface props + the
  // resolved/decorated ContentRenderer. Stable across renders unless one
  // of the underlying inputs (block, decorated renderer, surface props)
  // actually changed.
  const ContentSlot = useMemo<ComponentType>(() => {
    // Top-of-panel content renders as a title: larger font, less
    // bullet-list visual weight. The Controls slot already returns
    // null for top-level so there's no inline bullet to suppress
    // here. Class hook is applied here (not on the layout's outer
    // shell) so contributing renderers don't have to opt in.
    const topLevelClass = isTopLevel ? ' top-level-content' : ''
    return function BlockContentSlot() {
      return (
        <div
          {...contentSurfaceProps}
          className={`block-content${topLevelClass}${contentSurfaceProps.className ? ` ${contentSurfaceProps.className}` : ''}`}
          ref={contentContainerRef}
        >
          <ErrorBoundary FallbackComponent={FallbackComponent}>
            {/* ContentRenderer comes from the registry-driven
                decorate(blockContentDecoratorsFacet) memo above —
                stable identity per blockInteractionContext, not a
                fresh component each render. */}
            <ContentRenderer block={block}/>
          </ErrorBoundary>
        </div>
      )
    }
  }, [block, ContentRenderer, contentSurfaceProps, isTopLevel])

  const PropertiesSlot = useMemo<ComponentType | null>(() => {
    if (!showProperties) return null
    return function BlockPropertiesSlot() {
      return <BlockProperties block={block}/>
    }
  }, [block, showProperties])

  const ChildrenSlot = useMemo<ComponentType>(() => {
    return function BlockChildrenSlot() {
      return <BlockChildren block={block}/>
    }
  }, [block])

  const FooterSlot = useMemo<ComponentType>(() => {
    return function BlockFooterSlot() {
      return (
        <>
          {childrenFooterSections.map((SectionRenderer, index) => (
            <ErrorBoundary key={index} FallbackComponent={FallbackComponent}>
              <SectionRenderer block={block}/>
            </ErrorBoundary>
          ))}
        </>
      )
    }
  }, [block, childrenFooterSections])

  // Controls slot: bullet + expand affordances. Self-aware of top-level
  // (returns null since top-level blocks have no bullet) and of mobile
  // (renders the expand button as a top-right floater rather than inline
  // because mobile screens don't have desktop's horizontal real estate).
  const ControlsSlot = useMemo<ComponentType>(() => {
    return function BlockControlsSlot() {
      const isFocal = useIsFocalRender(block)
      const isMobile = useIsMobile()
      const hasChildren = useHasChildren(block)

      if (isFocal) return null

      return (
        <>
          <div className="block-controls flex items-center">
            {!isMobile && <ExpandButton block={block}/>}
            <BlockBullet block={block}/>
          </div>
          {isMobile && hasChildren && (
            <div className="absolute right-0 top-0 z-10">
              <ExpandButton block={block}/>
            </div>
          )}
        </>
      )
    }
  }, [block])

  const HeaderSlot = useMemo<ComponentType>(() => {
    return function BlockHeaderSlot() {
      return (
        <>
          {headerSections.map((SectionRenderer, index) => (
            <ErrorBoundary key={index} FallbackComponent={FallbackComponent}>
              <SectionRenderer block={block}/>
            </ErrorBoundary>
          ))}
        </>
      )
    }
  }, [block, headerSections])

  const shellProps = useMemo<BlockShellProps>(() => ({
    'data-block-id': block.id,
    'data-render-scope-id': typeof blockContext.renderScopeId === 'string'
      ? blockContext.renderScopeId
      : undefined,
    'data-editing': inEditMode ? 'true' : 'false',
    tabIndex: 0,
    ref: shellRef,
    onClick: handleBlockClick
      ? (event) => { void handleBlockClick(event) }
      : undefined,
    onPaste: (event) => { void handlePaste(event) },
  }), [block.id, blockContext.renderScopeId, inEditMode, handleBlockClick, handlePaste])

  const initialShellState = useMemo<BlockShellState>(() => ({
    shellProps,
    shortcutSurfaceOptions: {},
  }), [shellProps])

  const ShellBody = useMemo<ComponentType<{state: BlockShellState}>>(() => {
    return function BlockShellBody({state}: {state: BlockShellState}) {
      useShortcutSurfaceActivations(block, 'block', state.shortcutSurfaceOptions)

      const layoutSlots: BlockLayoutSlots = {
        block,
        Content: ContentSlot,
        Properties: PropertiesSlot,
        Children: ChildrenSlot,
        Footer: FooterSlot,
        Controls: ControlsSlot,
        Header: HeaderSlot,
        shellProps: state.shellProps,
      }

      return <Layout {...layoutSlots}/>
    }
  }, [
    block,
    ContentSlot, PropertiesSlot, ChildrenSlot, FooterSlot,
    ControlsSlot, HeaderSlot,
    Layout,
  ])

  return (
    <BlockShellDecoratorStack
      decorators={shellDecorators}
      resolveContext={resolveContext}
      shellRef={shellRef}
      contentRef={contentContainerRef}
      state={initialShellState}
      ShellBody={ShellBody}
    />
  )
}
