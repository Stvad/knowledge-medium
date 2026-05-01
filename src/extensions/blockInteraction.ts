import type {
  ClipboardEvent,
  ComponentType,
  HTMLAttributes,
  MouseEvent,
} from 'react'
import type { EditorView } from '@codemirror/view'
import { Block } from '@/data/internals/block'
import {
  editorSelection,
  selectionStateProp,
  setFocusedBlockId,
  setIsEditing,
  requestEditorFocus,
} from '@/data/properties.ts'
import {
  getSelectionStateSnapshot,
  resetBlockSelection,
} from '@/data/globalState.ts'
import { Repo } from '@/data/internals/repo'
import { combineLastContributionResult, defineFacet, isFunction } from '@/extensions/facet.ts'
import type { ActionContextActivation } from '@/shortcuts/types.ts'
import type { BlockContextType, BlockRenderer } from '@/types.ts'
import { extendSelection, validateSelectionHierarchy } from '@/utils/selection.ts'

export interface BlockContentRendererSlot {
  id: string
  renderer: BlockRenderer
}

/**
 * Stable per-block input to facet resolvers. Identity changes only on
 * block swap, panel-context change (panelId/safeMode/etc.), or zoom
 * (topLevelBlockId). Crucially does NOT include focus / edit mode /
 * selection — those are reactive UI state, and folding them into the
 * resolver context would re-run every facet resolver and reswap every
 * decorator/layout/slot identity on each focus toggle.
 *
 * Contributions that need reactive state read it inside their rendered
 * components via `useInFocus(block.id)` / `useInEditMode(block.id)` /
 * `useIsSelected(block.id)`, or at fire time via snapshot helpers.
 */
export interface BlockResolveContext {
  block: Block
  repo: Repo
  uiStateBlock: Block
  topLevelBlockId?: string
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

export type BlockContentRendererContribution =
  (context: BlockResolveContext) => BlockRenderer | null | undefined | false

export type BlockContentRendererResolver =
  (context: BlockResolveContext) => BlockRenderer | undefined

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

// Slot for sections rendered above a block's body — top-level breadcrumbs
// live here by default. Mirrors `blockChildrenFooterFacet` exactly: each
// contribution returns a renderer (or null/undefined/false to opt out
// for this block); the layout renders all returned components in
// contribution order.
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
  'data-editing': 'true' | 'false'
  tabIndex: number
  onClick?: (event: MouseEvent<HTMLElement>) => void
  onPaste?: (event: ClipboardEvent<HTMLElement>) => void
}

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

export type BlockLayoutContribution =
  (context: BlockResolveContext) => BlockLayout | null | undefined | false

export type BlockLayoutResolver =
  (context: BlockResolveContext) => BlockLayout | undefined

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

export const blockLayoutFacet = defineFacet<
  BlockLayoutContribution,
  BlockLayoutResolver
>({
  id: 'core.block-layout',
  combine: combineLastContributionResult<BlockResolveContext, BlockLayout>(),
  empty: () => () => undefined,
  validate: isFunction<BlockLayoutContribution>,
})

export type ShortcutSurface =
  | 'block'
  | 'codemirror'
  | (string & {})

export interface ShortcutSurfaceContext extends BlockInteractionContext {
  surface: ShortcutSurface
  editorView?: EditorView
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

export const blockContentRendererFacet = defineFacet<
  BlockContentRendererContribution,
  BlockContentRendererResolver
>({
  id: 'core.block-content-renderer',
  combine: combineLastContributionResult<BlockResolveContext, BlockRenderer>(
    context => getBlockContentRendererSlot(context, 'primary'),
  ),
  empty: () => context => getBlockContentRendererSlot(context, 'primary'),
  validate: isFunction<BlockContentRendererContribution>,
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

export const focusBlock = ({block, uiStateBlock}: BlockResolveContext) => {
  setFocusedBlockId(uiStateBlock, block.id)
}

export const enterBlockEditMode = async (
  context: BlockResolveContext,
  selection?: EditorActivationSelection,
) => {
  const {block, uiStateBlock} = context

  // Read-only workspace: clicks/keyboard shouldn't drop into edit mode, but
  // we still want the click target to register as focused so navigation
  // affordances (highlight, keyboard nav anchor) work.
  if (uiStateBlock.repo.isReadOnly) {
    setFocusedBlockId(uiStateBlock, block.id)
    return
  }

  await resetBlockSelection(uiStateBlock)
  setFocusedBlockId(uiStateBlock, block.id)
  setIsEditing(uiStateBlock, true)

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
  const {block, repo, uiStateBlock} = context

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
    await extendSelection(block.id, uiStateBlock, repo)
  } else {
    await resetBlockSelection(uiStateBlock)
  }

  focusBlock(context)
}

export const isSelectionClick = (event: MouseEvent) =>
  event.ctrlKey || event.metaKey || event.shiftKey
