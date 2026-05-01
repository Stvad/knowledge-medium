import type { ComponentType, HTMLAttributes, MouseEvent } from 'react'
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

export interface BlockInteractionContext {
  block: Block
  repo: Repo
  uiStateBlock: Block
  topLevelBlockId?: string
  inFocus: boolean
  inEditMode: boolean
  isSelected: boolean
  isTopLevel: boolean
  blockContext?: BlockContextType
  contentRenderers?: readonly BlockContentRendererSlot[]
}

export interface EditorActivationSelection {
  x?: number
  y?: number
  start?: number
  end?: number
}

export type BlockMouseHandler = (event: MouseEvent) => void | Promise<void>

export type BlockContentRendererContribution =
  (context: BlockInteractionContext) => BlockRenderer | null | undefined | false

export type BlockContentRendererResolver =
  (context: BlockInteractionContext) => BlockRenderer | undefined

export type BlockContentDecorator =
  (innerRenderer: BlockRenderer) => BlockRenderer

export type BlockContentDecoratorContribution =
  (context: BlockInteractionContext) => BlockContentDecorator | null | undefined | false

export type BlockContentDecoratorResolver =
  (context: BlockInteractionContext, inner: BlockRenderer) => BlockRenderer

export type BlockClickContribution =
  (context: BlockInteractionContext) => BlockMouseHandler | null | undefined | false

export type BlockClickResolver =
  (context: BlockInteractionContext) => BlockMouseHandler | undefined

export type BlockContentSurfaceProps = HTMLAttributes<HTMLDivElement>

export type BlockContentSurfaceContribution =
  (context: BlockInteractionContext) => BlockContentSurfaceProps | null | undefined | false

export type BlockContentSurfaceResolver =
  (context: BlockInteractionContext) => BlockContentSurfaceProps

// Slot for sections rendered after a block's children — Roam-style "Linked
// References" lives here. Each contribution returns a renderer (or null/
// undefined/false to opt out for this block); the DefaultBlockRenderer
// renders all returned components in contribution order.
export type BlockChildrenFooterContribution =
  (context: BlockInteractionContext) => BlockRenderer | null | undefined | false

export type BlockChildrenFooterResolver =
  (context: BlockInteractionContext) => readonly BlockRenderer[]

// Block layout — arranges the four slots (content, properties, children,
// footer) inside a block's body. The default vertical layout lives in
// `DefaultBlockLayout`; plugins contribute alternatives by returning a
// layout component for blocks they want to redress (e.g. a video block
// in notes view rendering content+children side-by-side).
//
// Each slot the layout receives is already wrapped in its own ErrorBoundary
// + interaction context boundary, so swapping the layout doesn't change
// shortcut-surface scoping or accidentally nest a child block inside the
// parent's content surface.
export interface BlockLayoutSlots {
  block: Block
  Content: ComponentType
  Properties: ComponentType | null
  Children: ComponentType
  Footer: ComponentType
}

export type BlockLayout = ComponentType<BlockLayoutSlots>

export type BlockLayoutContribution =
  (context: BlockInteractionContext) => BlockLayout | null | undefined | false

export type BlockLayoutResolver =
  (context: BlockInteractionContext) => BlockLayout | undefined

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
  combine: combineLastContributionResult<BlockInteractionContext, BlockLayout>(),
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
  context: BlockInteractionContext,
  slotId: string,
): BlockRenderer | undefined =>
  context.contentRenderers?.find(slot => slot.id === slotId)?.renderer

export const blockContentRendererFacet = defineFacet<
  BlockContentRendererContribution,
  BlockContentRendererResolver
>({
  id: 'core.block-content-renderer',
  combine: combineLastContributionResult<BlockInteractionContext, BlockRenderer>(
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
  combine: combineLastContributionResult<BlockInteractionContext, BlockMouseHandler>(),
  empty: () => () => undefined,
  validate: isFunction<BlockClickContribution>,
})

// Compose props from multiple contributions onto the same DOM node:
// - function-valued props (event handlers) are chained in contribution order
// - className strings are concatenated with a space
// - everything else is last-wins
export const mergeBlockContentSurfaceProps = (
  contributions: readonly BlockContentSurfaceContribution[],
  context: BlockInteractionContext,
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

export const focusBlock = ({block, uiStateBlock}: BlockInteractionContext) => {
  setFocusedBlockId(uiStateBlock, block.id)
}

export const enterBlockEditMode = async (
  context: BlockInteractionContext,
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
  context: BlockInteractionContext,
  event: MouseEvent,
) => {
  const {block, repo, uiStateBlock, isSelected} = context

  event.preventDefault()
  event.stopPropagation()

  if (event.ctrlKey || event.metaKey) {
    const selectionState = getSelectionStateSnapshot(uiStateBlock)
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
