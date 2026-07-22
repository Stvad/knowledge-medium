import { BlockRendererProps, BlockRenderer } from '@/types.js'
import { cn } from '@/lib/utils'
import { BlockProperties } from '../BlockProperties.tsx'
import { BlockChildren } from '../BlockComponent.tsx'
import { Button } from '../ui/button.tsx'
import { Collapsible, CollapsibleContent } from '../ui/collapsible.tsx'
import type { ComponentType, FunctionComponent, RefObject } from 'react'
import {
  showPropertiesProp,
  isCollapsedProp,
  topLevelBlockIdProp,
  typesProp,
} from '@/data/properties.js'
import { MarkdownContentRenderer } from '@/components/renderer/MarkdownContentRenderer.js'
import { CodeMirrorContentRenderer } from '@/components/renderer/CodeMirrorContentRenderer.js'
import { BulletHoverCard, useBulletHover } from '@/components/renderer/BulletHoverCard.js'
import { BlockInfoDialog } from '@/components/renderer/BlockInfoDialog.js'
import { openDialog } from '@/utils/dialogs.js'
import { useRef, useMemo } from 'react'
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
  blockBulletHoverFacet,
  blockChildrenFooterFacet,
  blockClickHandlersFacet,
  blockContentDecoratorsFacet,
  blockContentRendererFacet,
  blockContentSurfacePropsFacet,
  blockHeaderFacet,
  blockLayoutFacet,
  blockShellDecoratorsFacet,
  type BlockLayout,
  type BlockLayoutSlots,
  type BlockResolveContext,
  type BlockShellDecorator,
  type BlockShellRender,
  type BlockShellSlot,
  type BlockShellSlotProps,
  type BlockShellState,
  type BlockShellProps,
} from '@/extensions/blockInteraction.js'
import { useShortcutSurfaceActivations } from '@/extensions/useShortcutSurfaceActivations.js'
import { useContinuousGestures } from '@/extensions/continuousGestures.js'

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
        (withChildrenIndicator ? ' bullet-with-children border-4 border-solid border-border box-content' : '')}/>
  )
}

const BlockBullet = ({block, resolveContext}: { block: Block; resolveContext: BlockResolveContext }) => {
  const repo = useRepo()
  const runtime = useAppRuntime()
  const {panelId} = useBlockContext()
  const isMobile = useIsMobile()
  const [showProperties, setShowProperties] = usePropertyValue(block, showPropertiesProp)
  const [isCollapsed] = usePropertyValue(block, isCollapsedProp)

  const hasChildren = useHasChildren(block)

  // Bullet hover-card sections contributed by plugins (block-info, …). Empty
  // on a stock build — then the hover-intent and "Block info" menu item below
  // are inert / hidden, so the bullet behaves exactly as before.
  const resolveBulletHover = runtime.read(blockBulletHoverFacet)
  const hoverSections = useMemo(
    () => resolveBulletHover(resolveContext),
    [resolveBulletHover, resolveContext],
  )
  const hasHoverSections = hoverSections.length > 0
  // Desktop-only hover; touch users reach the same content via the context
  // menu's "Block info" item (which works with a mouse too).
  const hover = useBulletHover(hasHoverSections && !isMobile)

  const openBlockInfo = () => {
    void openDialog(BlockInfoDialog, {block, sections: hoverSections})
  }

  // App.tsx's bootstrap sets activeWorkspaceId before any block renders, so
  // the non-null assertion is the contract — not a defensive fallback.
  const workspaceId = repo.activeWorkspaceId!
  const onClick = useOpenBlock({blockId: block.id, workspaceId})

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <a
            href={buildAppHash(workspaceId, block.id)}
            className="bullet-link flex items-center justify-center h-6 w-5"
            onClick={(event) => {
              hover.close()
              onClick(event)
            }}
            onMouseEnter={hover.anchorHoverProps.onMouseEnter}
            onMouseLeave={hover.anchorHoverProps.onMouseLeave}
          >
            <BulletDot withChildrenIndicator={hasChildren && isCollapsed}/>
          </a>
        </ContextMenuTrigger>
        <ContextMenuPortal>
          <ContextMenuContent
            className="min-w-[160px] bg-background rounded-md p-1 shadow-md border border-border"
          >
            {hasHoverSections && (
              <>
                <ContextMenuItem
                  className="flex cursor-pointer items-center px-2 py-1.5 text-sm outline-none hover:bg-muted rounded-sm"
                  onSelect={openBlockInfo}
                >
                  Block info
                </ContextMenuItem>
                <ContextMenuSeparator className="h-px bg-border my-1"/>
              </>
            )}
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
      <BulletHoverCard
        open={hover.open}
        anchorEl={hover.anchorEl}
        hoverProps={hover.cardHoverProps}
      >
        {hoverSections.map((Section, index) => (
          <ErrorBoundary key={index} FallbackComponent={FallbackComponent}>
            <Section block={block}/>
          </ErrorBoundary>
        ))}
      </BulletHoverCard>
    </>
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
      className={cn('expand-collapse-button p-0 hover:bg-none transition-opacity duration-200', visibilityClass, isMobile ? 'h-8 w-8' : 'h-6 w-3')}
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
  Shell,
}) => {
  const isSelected = useIsSelected(block.id)
  const isTopLevel = useIsFocalRender(block)
  const [isCollapsed] = usePropertyValue(block, isCollapsedProp)

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

  // The interactive shell wraps the focusable Collapsible (the shell props
  // land on it, exactly as before); rendering `Shell` is what makes this an
  // editable, shortcut-bearing block surface.
  return (
    <div>
      <Header/>

      <Shell>
        {(shellProps) => {
          const {className: shellClassName, ...collapsibleProps} = shellProps
          return (
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
          )
        }}
      </Shell>
    </div>
  )
}

/**
 * Stable leaf of the shell-decorator stack. Module-level, so its component
 * IDENTITY never changes — the layout's `render` closure arrives as an ordinary
 * prop, so when the layout hands a fresh one (every render, since it closes over
 * collapse/selection/focus state) the leaf RE-RENDERS rather than remounting.
 * If the leaf's type churned, React would tear down the whole block subtree
 * (Collapsible → content → CodeMirror) on every selection/collapse toggle. Also
 * the home of the block's 'block' shortcut surface.
 */
function BlockShellLeaf({
  block,
  state,
  render,
}: {
  block: Block
  state: BlockShellState
  render: BlockShellRender
}) {
  useShortcutSurfaceActivations(block, 'block', state.shortcutSurfaceOptions)
  return <>{render(state.shellProps)}</>
}

function BlockShellDecoratorStack({
  decorators,
  index = 0,
  resolveContext,
  shellRef,
  contentRef,
  state,
  block,
  render,
}: {
  decorators: readonly BlockShellDecorator[]
  index?: number
  resolveContext: BlockResolveContext
  shellRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  state: BlockShellState
  block: Block
  render: BlockShellRender
}) {
  const Decorator = decorators[index]
  if (!Decorator) return <BlockShellLeaf block={block} state={state} render={render}/>

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
            block={block}
            render={render}
          />
        )}
      </Decorator>
    </ExtensionRenderBoundary>
  )
}

/**
 * The opt-in interactive block surface (the `Shell` slot's body). Encapsulates
 * everything the editable block wrapper bears — the canonical data attributes +
 * focusable tabIndex, the click handler (`blockClickHandlersFacet`), the shell
 * decorators (selection/focus/paste/spatial), and `useShortcutSurfaceActivations`
 * — and yields the composed `shellProps` to the layout's render-prop. A layout renders
 * `<Shell>{shellProps => <wrapper {...shellProps}/>}</Shell>` to become a
 * focusable/editable block; a read-only layout (a reference) omits it, so none
 * of this machinery runs.
 */
function BlockShell({
  resolveContext,
  shellRef,
  contentRef,
  children,
}: {
  resolveContext: BlockResolveContext
  shellRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  children: BlockShellRender
}) {
  const runtime = useAppRuntime()
  const {block} = resolveContext
  // Always defined in practice (the parent passes `useBlockContext()`); the
  // `?? {}` keeps the type honest and returns the same stable object.
  const blockContext = resolveContext.blockContext ?? {}
  const inEditMode = useInEditMode(block.id)

  const resolveBlockClickHandler = runtime.read(blockClickHandlersFacet)
  const handleBlockClick = useMemo(
    () => resolveBlockClickHandler(resolveContext),
    [resolveBlockClickHandler, resolveContext],
  )

  // Base shell props. `onClick` comes from `blockClickHandlersFacet`; `onPaste`
  // is NOT set here — it's contributed by `blockPasteShellDecorator` (like
  // selection/focus), so paste composes with the rest of the shell decorators
  // rather than being hardcoded on the wrapper.
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
  }), [block.id, blockContext.renderScopeId, inEditMode, handleBlockClick, shellRef])

  const resolveBlockShellDecorators = runtime.read(blockShellDecoratorsFacet)
  const shellDecorators = useMemo(
    () => resolveBlockShellDecorators(resolveContext),
    [resolveBlockShellDecorators, resolveContext],
  )

  const initialShellState = useMemo<BlockShellState>(() => ({
    shellProps,
    shortcutSurfaceOptions: {},
  }), [shellProps])

  // The layout's `children` render-prop is passed straight through to the stable
  // `BlockShellLeaf` as the `render` prop — NOT baked into a memoized component.
  // The layout hands a fresh closure every render (it closes over collapse/
  // selection/focus state); routing it as data through a stable-identity leaf
  // re-renders the block subtree instead of remounting it on every toggle.
  return (
    <BlockShellDecoratorStack
      decorators={shellDecorators}
      resolveContext={resolveContext}
      shellRef={shellRef}
      contentRef={contentRef}
      state={initialShellState}
      block={block}
      render={children}
    />
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
  const [showProperties] = usePropertyValue(block, showPropertiesProp)
  const [types] = usePropertyValue(block, typesProp)

  const [topLevelBlockId] = useUIStateProperty(topLevelBlockIdProp)
  const shellRef = useRef<HTMLDivElement | null>(null)
  const contentContainerRef = useRef<HTMLDivElement | null>(null)
  const isTopLevel = useIsFocalRender(block)

  // The block's READ content, bare: the per-type read renderer in an error
  // boundary, no editable `block-content` wrapper, surface props, or gesture ref.
  // The SINGLE definition of "what the read content is": the reference layout
  // mounts it directly via the `RawContent` slot, AND it is the `primary`
  // (display) slot of the edit dispatcher below — so the editable `Content` slot
  // is literally chrome + edit-swap wrapped around this very node
  // (`<Content><RawContent/></Content>` in read mode), not a parallel re-render of
  // the same renderer. Built from `DefaultContentRenderer` (NOT the edit
  // dispatcher), so a reference can never flip into an editor because the target
  // is in edit mode elsewhere; it renders INLINE automatically inside a reference
  // (the renderer derives inline from the `isReference` surface — no synthetic flag).
  // Typed as a `FunctionComponent` (not `ComponentType`) so it's assignable both
  // to the `RawContent` slot AND directly to the dispatcher's `primary`
  // `BlockRenderer` slot below — no thunk needed.
  const RawContentSlot = useMemo<FunctionComponent>(() => {
    return function BlockRawContentSlot() {
      return (
        <ErrorBoundary FallbackComponent={FallbackComponent}>
          <DefaultContentRenderer block={block}/>
        </ErrorBoundary>
      )
    }
  }, [block, DefaultContentRenderer])

  // Stable per-block resolver context — doesn't change on focus/edit/
  // selection toggles, so facet resolvers and the components they
  // produce keep stable identity. This is what stops UpdateIndicator
  // (and any other content decorator) from remounting on every click.
  const scopeRootId = blockContext.scopeRootId
  const resolveContext = useMemo<BlockResolveContext>(() => ({
    block,
    repo,
    uiStateBlock,
    types,
    topLevelBlockId,
    scopeRootId,
    isTopLevel,
    blockContext,
    contentRenderers: [
      // The display (read) slot IS `RawContent`: the edit dispatcher renders it in
      // read mode (and the editor in edit mode), so the editable `Content` slot
      // composes the same read node the reference layout mounts — one source of
      // "the read content", not two.
      {
        id: 'primary',
        renderer: RawContentSlot,
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
    scopeRootId,
    isTopLevel,
    blockContext,
    RawContentSlot,
    EditContentRenderer,
  ])

  // Only the layout is resolved eagerly — it decides which slots get mounted,
  // and each slot owns (and only then pays for) its own machinery: the gesture
  // ref + content/click/surface facets live in `Content`, the section facets in
  // `Header`/`Footer`, and the whole interactive surface (paste, shell
  // decorators, shortcut activations) in `Shell`. A read-only layout (a block
  // reference) that mounts only `RawContent` therefore runs none of those
  // hooks — the lazy-slot equivalent of "don't allocate what you don't use".
  const resolveBlockLayout = runtime.read(blockLayoutFacet)
  // Last-wins on the variant facet. `DefaultBlockLayout` is the no-contribution
  // fallback.
  const Layout = useMemo(
    () => resolveBlockLayout(resolveContext).last?.render ?? DefaultBlockLayout,
    [resolveContext, resolveBlockLayout],
  )

  // Content slot: the editable content surface — gesture ref + surface props +
  // the resolved/decorated content renderer. Each input is resolved inside the
  // slot so it's only paid for when a layout actually mounts `<Content/>`.
  const ContentSlot = useMemo<ComponentType>(() => {
    return function BlockContentSlot() {
      // Continuous-gesture recognizers (swipe, date-scrub, …) attach native
      // Pointer Event listeners + touch-action to the content surface. A no-op
      // until a recognizer is contributed, so blocks with none pay nothing.
      const contentGestureRef = useContinuousGestures(resolveContext, contentContainerRef)
      // Memoize on resolveContext so contributions that synthesize a fresh
      // component each call (e.g. plain-outliner's edit-mode dispatcher) don't
      // hand back a new identity every render and remount the content subtree.
      const resolveBlockContentRenderer = runtime.read(blockContentRendererFacet)
      const baseContentRenderer = useMemo(
        () => resolveBlockContentRenderer(resolveContext).last?.render ?? DefaultContentRenderer,
        [resolveBlockContentRenderer],
      )
      const decorateContent = runtime.read(blockContentDecoratorsFacet)
      const ContentRenderer = useMemo(
        () => decorateContent(resolveContext, baseContentRenderer),
        [decorateContent, baseContentRenderer],
      )
      const resolveContentSurfaceProps = runtime.read(blockContentSurfacePropsFacet)
      const contentSurfaceProps = useMemo(
        () => resolveContentSurfaceProps(resolveContext),
        [resolveContentSurfaceProps],
      )
      // Top-of-panel content renders as a title: larger font, less bullet-list
      // weight. The Controls slot already returns null for top-level so there's
      // no inline bullet to suppress here.
      const topLevelClass = isTopLevel ? ' top-level-content' : ''
      return (
        <div
          {...contentSurfaceProps}
          data-block-visibility-target="true"
          className={`block-content${topLevelClass}${contentSurfaceProps.className ? ` ${contentSurfaceProps.className}` : ''}`}
          ref={contentGestureRef}
        >
          <ErrorBoundary FallbackComponent={FallbackComponent}>
            <ContentRenderer block={block}/>
          </ErrorBoundary>
        </div>
      )
    }
  }, [block, resolveContext, runtime, isTopLevel, DefaultContentRenderer, contentContainerRef])

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
      const resolveChildrenFooterSections = runtime.read(blockChildrenFooterFacet)
      const childrenFooterSections = useMemo(
        () => resolveChildrenFooterSections(resolveContext),
        [resolveChildrenFooterSections],
      )
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
  }, [block, resolveContext, runtime])

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
            <BlockBullet block={block} resolveContext={resolveContext}/>
          </div>
          {isMobile && hasChildren && (
            <div className="absolute right-0 top-0 z-10 flex h-6 items-center">
              <ExpandButton block={block}/>
            </div>
          )}
        </>
      )
    }
  }, [block, resolveContext])

  const HeaderSlot = useMemo<ComponentType>(() => {
    return function BlockHeaderSlot() {
      const resolveHeaderSections = runtime.read(blockHeaderFacet)
      const headerSections = useMemo(
        () => resolveHeaderSections(resolveContext),
        [resolveHeaderSections],
      )
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
  }, [block, resolveContext, runtime])

  // The opt-in interactive shell. Layouts render `<Shell>{shellProps => …}</Shell>`
  // to become focusable/editable; the shell's machinery (paste/click, shell
  // decorators, shortcut activations) only runs when mounted — see `BlockShell`.
  const ShellSlot = useMemo<BlockShellSlot>(() => {
    return function BlockShellSlot({children}: BlockShellSlotProps) {
      return (
        <BlockShell
          resolveContext={resolveContext}
          shellRef={shellRef}
          contentRef={contentContainerRef}
        >
          {children}
        </BlockShell>
      )
    }
  }, [resolveContext, shellRef, contentContainerRef])

  const layoutSlots: BlockLayoutSlots = {
    block,
    Content: ContentSlot,
    RawContent: RawContentSlot,
    Properties: PropertiesSlot,
    Children: ChildrenSlot,
    Footer: FooterSlot,
    Controls: ControlsSlot,
    Header: HeaderSlot,
    Shell: ShellSlot,
  }

  return <Layout {...layoutSlots}/>
}
