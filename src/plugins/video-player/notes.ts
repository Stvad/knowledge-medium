import type { Block } from '@/data/block'
import {
  editorSelection,
  focusedBlockIdProp,
  isEditingProp,
  requestEditorFocus,
} from '@/data/properties.ts'
import { videoPlayerViewProp } from './view.ts'

const focusNewVideoNote = async (noteId: string, uiStateBlock: Block): Promise<void> => {
  await uiStateBlock.set(focusedBlockIdProp, noteId)
  await uiStateBlock.set(editorSelection, {blockId: noteId, start: 0})

  if (uiStateBlock.repo.isReadOnly) return

  await uiStateBlock.set(isEditingProp, true)

  // Ensure a newly mounted editor receives focus even if edit mode was
  // already active before notes view opened.
  requestEditorFocus(uiStateBlock)
}

export const ensureEditableVideoNoteChild = async (
  videoBlock: Block,
  uiStateBlock: Block,
): Promise<string | null> => {
  if (videoBlock.repo.isReadOnly) return null

  const childIds = await videoBlock.childIds.load()
  if (childIds.length > 0) return null

  const newId = await videoBlock.repo.mutate.createChild({
    parentId: videoBlock.id,
    position: {kind: 'first'},
  }) as string

  if (!newId) return null

  await focusNewVideoNote(newId, uiStateBlock)
  return newId
}

export const enterVideoNotesView = async (
  videoBlock: Block,
  uiStateBlock: Block,
): Promise<void> => {
  await videoBlock.set(videoPlayerViewProp, 'notes')
  await ensureEditableVideoNoteChild(videoBlock, uiStateBlock)
}
