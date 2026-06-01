import type {
  ClipboardEvent,
  ComponentType,
  FocusEvent,
  HTMLAttributes,
  MouseEvent,
  PointerEvent,
  Ref,
  RefObject,
  ReactNode,
} from 'react'
import type { EditorView } from '@codemirror/view'
import { Block } from '../data/block'
import {
  editorSelection,
  focusBlock,
  selectionStateProp,
  requestEditorFocus,
} from '@/data/properties.js'
import {
  getSelectionStateSnapshot,
  resetBlockSelection,
} from '@/data/stateBlocks.js'
import { Repo } from '../data/repo'
import { combineLastContributionResult, defineFacet, isFunction } from '@/extensions/facet.js'
import {
  defineVariantFacet,
  type Variant,
  type VariantContribution,
  type VariantResolver,
} from '@/extensions/variantFacet.js'
import type { ActionContextActivation } from '@/shortcuts/types.js'
import type { BlockContextType, BlockRenderer } from '@/types.js'
import { extendSelection, validateSelectionHierarchy } from '@/utils/selection.js'

export interface BlockContentRendererSlot {
  id: string
  renderer: BlockRenderer
}

/**
 * Stable per-block input to facet resolvers. Identity changes only on
 * block swap, panel-context change (panelId/safeMode/etc.), or zoom
 * (topLevelBlockId), or the block's type membership. Crucially does
 * NOT include focus / edit mode / selection — those are reactive UI
 * state, and folding them into the resolver context would re-run every
 * facet resolver and reswap every decorator/layout/slot identity on
 * each focus toggle.
 *
 * Contributions that need reactive state read it inside their rendered
 * components via `useInFocus(block.id)` / `useInEditMode(block.id)` /
 * `useIsSelected(block.id)`, or at fire time via snapshot helpers.
 */
export interface BlockResolveContext {
  block: Block
  repo: Repo
  uiStateBlock: Block
  types: readonly string[]
  topLevelBlockId?: string
  /** Root of the visible subtree this mount renders (see
   *  `BlockContextType.scopeRootId`). Equals `topLevelBlockId` on the
   *  main outline; differs in nested surfaces (a backlink entry's shown
   *  block, an embedded block). Structural-edit and navigation handlers
   *  consume this as the surface boundary. */
  scopeRootId?: string
  /** Focal-on-document — `block.id === topLevelBlockId` AND the current
   *  mount is the document surface (not an embed, backlink entry, or
   *  breadcrumb preview). Populated by `useIsFocalRender(block)`; the
   *  pure helper `isFocalRender(ctx)` answers the same question for
   *  facet contributions that receive a `BlockResolveContext`. */
  isTopLevel: boolean
  blockContext?: BlockContextType
  contentRenderers?: readonly BlockContentRendererSlot[]
}

/**
 * Full interaction context — resolver context plus the reactive UI
 * state. Consumed only by `shortcutSurfaceActivationsFacet`, whose
 * activations legitimately re-evaluate on every reactive change to
 * scope which shortcut contexts are active. Other facets take
 * `BlockResolveContext` and read reactive state inside their rendered
 * components / fire-time handlers via hooks.
 */
export interface BlockInteractionContext extends BlockResolveContext {
  inFocus: boolean
  inEditMode: boolean
  isSelected: boolean
}

export interface EditorActivationSelection {
  x?: number
  y?: number
  start?: number
  end?: number
}

export type BlockMouseHandler = (event: MouseEvent) => void | Promise<void>

export type BlockContentRendererVariant = Variant<BlockRenderer>

// Variant facet — each contribution registers a named alternative
// content renderer. Most contributions self-gate (e.g. plain-outliner's
// edit-mode dispatcher returns its variant only when the primary slot
// is set), and the consumer picks `last` to preserve the legacy "last
// truthy contribution wins" behavior. Adding a user-facing picker
// later means reading a saved id and calling `byId` instead.
export type BlockContentRendererContribution =
  VariantContribution<BlockResolveContext, BlockRenderer>

export type BlockContentRendererResolver =
  VariantResolver<BlockResolveContext, BlockRenderer>

export type BlockContentDecorator =
  (innerRenderer: BlockRenderer) => BlockRenderer

export type BlockContentDecoratorContribution =
  (context: BlockResolveContext) => BlockContentDecorator | null | undefined | false

export type BlockContentDecoratorResolver =
  (context: BlockResolveContext, inner: BlockRenderer) => BlockRenderer

export type BlockClickContribution =
  (context: BlockResolveContext) => BlockMouseHandler | null | undefined | false

export type BlockClickResolver =
  (context: BlockResolveContext) => BlockMouseHandler | undefined

export type BlockContentSurfaceProps = HTMLAttributes<HTMLDivElement>

export type BlockContentSurfaceContribution =
  (context: BlockResolveContext) => BlockContentSurfaceProps | null | undefined | false

export type BlockContentSurfaceResolver =
  (context: BlockResolveContext) => BlockContentSurfaceProps

// Slot for sections rendered above a block's body — navigation chrome
// such as top-level breadcrumbs lives here. Mirrors
// `blockChildrenFooterFacet` exactly: each contribution returns a
// renderer (or null/undefined/false to opt out for this block); the
// layout renders all returned components in contribution order.
export type BlockHeaderContribution =
  (context: BlockResolveContext) => BlockRenderer | null | undefined | false

export type BlockHeaderResolver =
  (context: BlockResolveContext) => readonly BlockRenderer[]

// Slot for sections rendered after a block's children — Roam-style "Linked
// References" lives here. Each contribution returns a renderer (or null/
// undefined/false to opt out for this block); the DefaultBlockRenderer
// renders all returned components in contribution order.
export type BlockChildrenFooterContribution =
  (context: BlockResolveContext) => BlockRenderer | null | undefined | false

export type BlockChildrenFooterResolver =
  (context: BlockResolveContext) => readonly BlockRenderer[]

// Block layout — owns the entire shape of a block as rendered (the
// outer wrapper, controls placement, collapse behavior, and where the
// content/children/footer slots sit). The default vertical layout lives
// in `DefaultBlockLayout`; plugins contribute alternatives by returning
// a layout component for blocks they want to redress.
//
// Each slot the layout receives is already wrapped in its own
// ErrorBoundary + interaction context boundary, so swapping the layout
// doesn't change shortcut-surface scoping or accidentally nest a child
// block inside the parent's content surface.
//
// Slots are defined by the framework — even when a layout chooses not
// to render one, the slot still exists as a function it can ignore.
// `Properties` is `null` when the block has them hidden; the layout
// uses `{Properties && <Properties/>}` to skip rendering.
//
// Shell concerns the *typical* block wrapper bears (click/paste handler
// dispatch, the canonical `data-block-id` / `data-editing` attributes,
// the focusable tabIndex) are exposed as `shellProps`. The default
// layout splats them onto its outer Collapsible; custom layouts apply
// where appropriate or ignore entirely (a fullscreen overlay layout
// has no need for any of them).
export interface BlockShellProps {
  'data-block-id': string
  'data-render-scope-id'?: string
  'data-editing': 'true' | 'false'
  className?: string
  tabIndex: number
  ref?: Ref<HTMLDivElement>
  onFocus?: (event: FocusEvent<HTMLElement>) => void
  onMouseDownCapture?: (event: MouseEvent<HTMLElement>) => void
  onPointerDownCapture?: (event: PointerEvent<HTMLElement>) => void
  onClick?: (event: MouseEvent<HTMLElement>) => void
  onPaste?: (event: ClipboardEvent<HTMLElement>) => void
}

export interface BlockShellState {
  shellProps: BlockShellProps
  shortcutSurfaceOptions: Record<string, unknown>
}

export interface BlockShellDecoratorProps {
  resolveContext: BlockResolveContext
  shellRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  state: BlockShellState
  children: (state: BlockShellState) => ReactNode
}

export type BlockShellDecorator = ComponentType<BlockShellDecoratorProps>

// Hook-safe shell extension point. Contributions return a component
// that wraps the block shell render with a render-prop state transform,
// so plugin hooks can contribute wrapper props / shortcut metadata
// without being called directly by DefaultBlockRenderer.
export type BlockShellDecoratorContribution =
  (context: BlockResolveContext) => BlockShellDecorator | null | undefined | false

export type BlockShellDecoratorResolver =
  (context: BlockResolveContext) => readonly BlockShellDecorator[]

export interface BlockLayoutSlots {
  block: Block
  /** Block content surface — content renderer + surface props + error boundary. */
  Content: ComponentType
  /** Block properties (metadata key/value pairs); `null` when hidden. */
  Properties: ComponentType | null
  /** Block children subtree (raw `BlockChildren`; layout decides whether to wrap in CollapsibleContent). */
  Children: ComponentType
  /** After-children sections contributed via `blockChildrenFooterFacet`. */
  Footer: ComponentType
  /** Bullet + expand-collapse affordances; renders nothing when not appropriate (top-level). */
  Controls: ComponentType
  /** Above-body sections contributed via `blockHeaderFacet` (top-level breadcrumbs by default). */
  Header: ComponentType
  /** Shell-level attributes + handlers the typical block wrapper bears. */
  shellProps: BlockShellProps
}

export type BlockLayout = ComponentType<BlockLayoutSlots>

export type BlockLayoutVariant = Variant<BlockLayout>

// Variant facet — each contribution registers a named alternative
// layout. Plugins typically self-gate by context (e.g. the video
// player layout only contributes for the video block); the consumer
// picks `last` to preserve last-wins behavior.
export type BlockLayoutContribution =
  VariantContribution<BlockResolveContext, BlockLayout>

export type BlockLayoutResolver =
  VariantResolver<BlockResolveContext, BlockLayout>

export const blockHeaderFacet = defineFacet<
  BlockHeaderContribution,
  BlockHeaderResolver
>({
  id: 'core.block-header',
  combine: contributions => context => {
    const result: BlockRenderer[] = []
    for (const contribution of contributions) {
      const renderer = contribution(context)
      if (renderer) result.push(renderer)
    }
    return result
  },
  empty: () => () => [],
  validate: isFunction<BlockHeaderContribution>,
})

export const blockChildrenFooterFacet = defineFacet<
  BlockChildrenFooterContribution,
  BlockChildrenFooterResolver
>({
  id: 'core.block-children-footer',
  combine: contributions => context => {
    const result: BlockRenderer[] = []
    for (const contribution of contributions) {
      const renderer = contribution(context)
      if (renderer) result.push(renderer)
    }
    return result
  },
  empty: () => () => [],
  validate: isFunction<BlockChildrenFooterContribution>,
})

export const blockLayoutFacet = defineVariantFacet<BlockResolveContext, BlockLayout>({
  id: 'core.block-layout',
})

export const blockShellDecoratorsFacet = defineFacet<
  BlockShellDecoratorContribution,
  BlockShellDecoratorResolver
>({
  id: 'core.block-shell-decorators',
  combine: contributions => context => {
    const result: BlockShellDecorator[] = []
    for (const contribution of contributions) {
      const decorator = contribution(context)
      if (decorator) result.push(decorator)
    }
    return result
  },
  empty: () => () => [],
  validate: isFunction<BlockShellDecoratorContribution>,
})

export type ShortcutSurface =
  | 'block'
  | 'codemirror'
  | (string & {})

export interface ShortcutSurfaceContext extends BlockInteractionContext {
  surface: ShortcutSurface
  editorView?: EditorView
  [key: string]: unknown
}

export type ShortcutActivationContribution =
  (context: ShortcutSurfaceContext) => readonly ActionContextActivation[] | null | undefined | false

export type ShortcutActivationResolver =
  (context: ShortcutSurfaceContext) => readonly ActionContextActivation[]

export const getBlockContentRendererSlot = (
  context: BlockResolveContext,
  slotId: string,
): BlockRenderer | undefined =>
  context.contentRenderers?.find(slot => slot.id === slotId)?.renderer

export const blockContentRendererFacet = defineVariantFacet<BlockResolveContext, BlockRenderer>({
  id: 'core.block-content-renderer',
})

// Layered decoration on top of the chosen content renderer. Lower
// precedence wraps closer to the inner renderer; the last contribution
// applied is the outermost layer (its chrome is furthest from the inner
// content). Returning null/undefined/false from a contribution skips it
// for that block. Decorator authors should memoize the wrapped component
// per-inner so React doesn't unmount the inner subtree on every render.
export const blockContentDecoratorsFacet = defineFacet<
  BlockContentDecoratorContribution,
  BlockContentDecoratorResolver
>({
  id: 'core.block-content-decorators',
  combine: contributions => (context, inner) => {
    let renderer = inner
    for (const contribution of contributions) {
      const decorator = contribution(context)
      if (decorator) renderer = decorator(renderer)
    }
    return renderer
  },
  empty: () => (_context, inner) => inner,
  validate: isFunction<BlockContentDecoratorContribution>,
})

export const blockClickHandlersFacet = defineFacet<
  BlockClickContribution,
  BlockClickResolver
>({
  id: 'core.block-click-handlers',
  combine: combineLastContributionResult<BlockResolveContext, BlockMouseHandler>(),
  empty: () => () => undefined,
  validate: isFunction<BlockClickContribution>,
})

// Compose props from multiple contributions onto the same DOM node:
// - function-valued props (event handlers) are chained in contribution order
// - className strings are concatenated with a space
// - everything else is last-wins
export const mergeBlockContentSurfaceProps = (
  contributions: readonly BlockContentSurfaceContribution[],
  context: BlockResolveContext,
): BlockContentSurfaceProps => {
  const merged: Record<string, unknown> = {}

  for (const contribution of contributions) {
    const props = contribution(context)
    if (!props) continue

    for (const [key, value] of Object.entries(props)) {
      const existing = merged[key]
      if (typeof value === 'function' && typeof existing === 'function') {
        const prev = existing as (...args: unknown[]) => unknown
        const next = value as (...args: unknown[]) => unknown
        merged[key] = (...args: unknown[]) => {
          prev(...args)
          next(...args)
        }
      } else if (key === 'className' && typeof value === 'string' && typeof existing === 'string') {
        merged[key] = `${existing} ${value}`
      } else {
        merged[key] = value
      }
    }
  }

  return merged as BlockContentSurfaceProps
}

export const blockContentSurfacePropsFacet = defineFacet<
  BlockContentSurfaceContribution,
  BlockContentSurfaceResolver
>({
  id: 'core.block-content-surface-props',
  combine: contributions => context => mergeBlockContentSurfaceProps(contributions, context),
  empty: () => () => ({}),
  validate: isFunction<BlockContentSurfaceContribution>,
})

export const resolveShortcutActivations = (
  contributions: readonly ShortcutActivationContribution[],
  context: ShortcutSurfaceContext,
): readonly ActionContextActivation[] =>
  contributions.flatMap(contribution => contribution(context) || [])

export const shortcutSurfaceActivationsFacet = defineFacet<
  ShortcutActivationContribution,
  ShortcutActivationResolver
>({
  id: 'core.shortcut-surface-activations',
  combine: contributions => context => resolveShortcutActivations(contributions, context),
  empty: () => () => [],
  validate: isFunction<ShortcutActivationContribution>,
})

const interactiveContentSelector = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'details',
  'iframe',
  'object',
  'embed',
  'audio[controls]',
  'video[controls]',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[data-block-interaction="ignore"]',
].join(',')

export const isInteractiveContentEvent = (event: { target: EventTarget | null }) => {
  const target = event.target
  if (typeof Node === 'undefined' || !(target instanceof Node)) return false
  const element = target.nodeType === Node.ELEMENT_NODE
    ? target as Element
    : target.parentElement
  return Boolean(element?.closest(interactiveContentSelector))
}

export const enterBlockEditMode = async (
  context: BlockResolveContext,
  selection?: EditorActivationSelection,
) => {
  const {block, uiStateBlock} = context
  const renderScopeId = typeof context.blockContext?.renderScopeId === 'string'
    ? context.blockContext.renderScopeId
    : undefined

  // Read-only workspace: clicks/keyboard shouldn't drop into edit mode, but
  // we still want the click target to register as focused so navigation
  // affordances (highlight, keyboard nav anchor) work. `focusBlock` honors
  // the read-only gate internally — `{edit: true}` here becomes a noop on
  // the edit flag in read-only mode.
  if (uiStateBlock.repo.isReadOnly) {
    void focusBlock(uiStateBlock, block.id, {renderScopeId})
    return
  }

  await resetBlockSelection(uiStateBlock)
  await focusBlock(uiStateBlock, block.id, {edit: true, renderScopeId})

  if (selection) {
    void uiStateBlock.set(editorSelection, {
      blockId: block.id,
      ...selection,
    })
  }

  requestEditorFocus(uiStateBlock)
}

export const handleBlockSelectionClick = async (
  context: BlockResolveContext,
  event: MouseEvent,
) => {
  if (isInteractiveContentEvent(event)) return

  const {block, repo, uiStateBlock} = context
  const renderScopeId = typeof context.blockContext?.renderScopeId === 'string'
    ? context.blockContext.renderScopeId
    : undefined

  event.preventDefault()
  event.stopPropagation()

  if (event.ctrlKey || event.metaKey) {
    const selectionState = getSelectionStateSnapshot(uiStateBlock)
    const isSelected = selectionState.selectedBlockIds.includes(block.id)
    const newSelectedIds = isSelected
      ? selectionState.selectedBlockIds.filter(id => id !== block.id)
      : [...selectionState.selectedBlockIds, block.id]

    const validatedIds = await validateSelectionHierarchy(newSelectedIds, repo)

    void uiStateBlock.set(selectionStateProp, {
      selectedBlockIds: validatedIds,
      anchorBlockId: validatedIds.length > 0
        ? (selectionState.anchorBlockId || block.id)
        : null,
    })
  } else if (event.shiftKey) {
    await extendSelection(block.id, uiStateBlock, repo, context.scopeRootId, !context.blockContext?.isNestedSurface)
  } else {
    await resetBlockSelection(uiStateBlock)
  }

  void focusBlock(uiStateBlock, block.id, {renderScopeId})
}

export const isSelectionClick = (event: MouseEvent) =>
  event.ctrlKey || event.metaKey || event.shiftKey
