import type { MouseEvent, TouchEvent } from 'react'
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
import { extendSelection, validateSelectionHierarchy } from '@/utils/selection.ts'

export type BlockContentMode = 'preview' | 'editor'

export interface BlockInteractionContext {
  block: Block
  repo: Repo
  uiStateBlock: Block
  topLevelBlockId?: string
  inFocus: boolean
  inEditMode: boolean
  isSelected: boolean
  isTopLevel: boolean
}

export interface EditorActivationSelection {
  x?: number
  y?: number
  start?: number
  end?: number
}

export interface BlockInteractionPolicy {
  contentMode: BlockContentMode
  activateNormalMode: boolean
  handleBlockClick?: (event: MouseEvent) => void | Promise<void>
  handleContentDoubleClick?: (event: MouseEvent) => void | Promise<void>
  handleContentTap?: (event: TouchEvent) => void | Promise<void>
}

export type BlockInteractionPolicyConfig =
  | Partial<BlockInteractionPolicy>
  | null
  | undefined
  | false

export type BlockInteractionPolicyExtension =
  (context: BlockInteractionContext) => BlockInteractionPolicyConfig

export type BlockInteractionPolicyResolver =
  (context: BlockInteractionContext) => BlockInteractionPolicy

export const isBlockInteractionPolicyExtension = (
  value: unknown,
): value is BlockInteractionPolicyExtension => typeof value === 'function'

export const createBaseBlockInteractionPolicy = (
  context: BlockInteractionContext,
): BlockInteractionPolicy => ({
  contentMode: context.inEditMode ? 'editor' : 'preview',
  activateNormalMode: false,
})

export const resolveBlockInteractionPolicy = (
  extensions: readonly BlockInteractionPolicyExtension[],
  context: BlockInteractionContext,
): BlockInteractionPolicy => {
  const policy = createBaseBlockInteractionPolicy(context)

  for (const extension of extensions) {
    const extensionPolicy = extension(context)
    if (!extensionPolicy) continue

    Object.assign(policy, extensionPolicy)
  }

  return policy
}

export const blockInteractionPolicyFacet = defineFacet<
  BlockInteractionPolicyExtension,
  BlockInteractionPolicyResolver
>({
  id: 'core.block-interaction-policy',
  combine: extensions => context => resolveBlockInteractionPolicy(extensions, context),
  empty: () => createBaseBlockInteractionPolicy,
  validate: isBlockInteractionPolicyExtension,
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
