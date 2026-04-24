import type { MouseEvent, TouchEvent } from 'react'
import type { EditorView } from '@codemirror/view'
import { Block } from '@/data/block.ts'
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
import { Repo } from '@/data/repo.ts'
import { defineFacet } from '@/extensions/facet.ts'
import type { ActionContextActivation } from '@/shortcuts/types.ts'
import type { BlockRenderer } from '@/types.ts'
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
  contentRenderers?: readonly BlockContentRendererSlot[]
}

export interface EditorActivationSelection {
  x?: number
  y?: number
  start?: number
  end?: number
}

export type BlockMouseHandler = (event: MouseEvent) => void | Promise<void>
export type BlockTouchHandler = (event: TouchEvent) => void | Promise<void>

export type BlockContentRendererContribution =
  (context: BlockInteractionContext) => BlockRenderer | null | undefined | false

export type BlockContentRendererResolver =
  (context: BlockInteractionContext) => BlockRenderer | undefined

export type BlockClickContribution =
  (context: BlockInteractionContext) => BlockMouseHandler | null | undefined | false

export type BlockClickResolver =
  (context: BlockInteractionContext) => BlockMouseHandler | undefined

export interface BlockContentGestureHandlers {
  onDoubleClick?: BlockMouseHandler
  onTap?: BlockTouchHandler
}

export type BlockContentGestureContribution =
  (context: BlockInteractionContext) => BlockContentGestureHandlers | null | undefined | false

export type BlockContentGestureResolver =
  (context: BlockInteractionContext) => BlockContentGestureHandlers

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

export const isBlockContentRendererContribution = (
  value: unknown,
): value is BlockContentRendererContribution =>
  typeof value === 'function'

export const isBlockClickContribution = (
  value: unknown,
): value is BlockClickContribution =>
  typeof value === 'function'

export const isBlockContentGestureContribution = (
  value: unknown,
): value is BlockContentGestureContribution =>
  typeof value === 'function'

export const isShortcutActivationContribution = (
  value: unknown,
): value is ShortcutActivationContribution =>
  typeof value === 'function'

export const getBlockContentRendererSlot = (
  context: BlockInteractionContext,
  slotId: string,
): BlockRenderer | undefined =>
  context.contentRenderers?.find(slot => slot.id === slotId)?.renderer

export const resolveBlockContentRenderer = (
  contributions: readonly BlockContentRendererContribution[],
  context: BlockInteractionContext,
): BlockRenderer | undefined => {
  let renderer = getBlockContentRendererSlot(context, 'primary')

  for (const contribution of contributions) {
    const contributedRenderer = contribution(context)
    if (contributedRenderer) renderer = contributedRenderer
  }

  return renderer
}

export const blockContentRendererFacet = defineFacet<
  BlockContentRendererContribution,
  BlockContentRendererResolver
>({
  id: 'core.block-content-renderer',
  combine: contributions => context => resolveBlockContentRenderer(contributions, context),
  empty: () => context => getBlockContentRendererSlot(context, 'primary'),
  validate: isBlockContentRendererContribution,
})

export const resolveBlockClickHandler = (
  contributions: readonly BlockClickContribution[],
  context: BlockInteractionContext,
): BlockMouseHandler | undefined => {
  let handler: BlockMouseHandler | undefined

  for (const contribution of contributions) {
    const contributedHandler = contribution(context)
    if (contributedHandler) handler = contributedHandler
  }

  return handler
}

export const blockClickHandlersFacet = defineFacet<
  BlockClickContribution,
  BlockClickResolver
>({
  id: 'core.block-click-handlers',
  combine: contributions => context => resolveBlockClickHandler(contributions, context),
  empty: () => () => undefined,
  validate: isBlockClickContribution,
})

export const resolveBlockContentGestureHandlers = (
  contributions: readonly BlockContentGestureContribution[],
  context: BlockInteractionContext,
): BlockContentGestureHandlers => {
  const handlers: BlockContentGestureHandlers = {}

  for (const contribution of contributions) {
    const contributedHandlers = contribution(context)
    if (!contributedHandlers) continue

    Object.assign(handlers, contributedHandlers)
  }

  return handlers
}

export const blockContentGestureHandlersFacet = defineFacet<
  BlockContentGestureContribution,
  BlockContentGestureResolver
>({
  id: 'core.block-content-gesture-handlers',
  combine: contributions => context => resolveBlockContentGestureHandlers(contributions, context),
  empty: () => () => ({}),
  validate: isBlockContentGestureContribution,
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
  validate: isShortcutActivationContribution,
})

export const focusBlock = ({block, uiStateBlock}: BlockInteractionContext) => {
  setFocusedBlockId(uiStateBlock, block.id)
}

export const enterBlockEditMode = async (
  context: BlockInteractionContext,
  selection?: EditorActivationSelection,
) => {
  const {block, uiStateBlock} = context

  await resetBlockSelection(uiStateBlock)
  setFocusedBlockId(uiStateBlock, block.id)
  setIsEditing(uiStateBlock, true)

  if (selection) {
    uiStateBlock.setProperty({
      ...editorSelection,
      value: {
        blockId: block.id,
        ...selection,
      },
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

    uiStateBlock.setProperty({
      ...selectionStateProp,
      value: {
        selectedBlockIds: validatedIds,
        anchorBlockId: validatedIds.length > 0
          ? (selectionState.anchorBlockId || block.id)
          : null,
      },
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
