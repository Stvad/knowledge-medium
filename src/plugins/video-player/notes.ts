import type { Block } from '@/data/block'
import {
  editorSelection,
  focusBlock,
  requestEditorFocus,
} from '@/data/properties.js'
import { videoPlayerViewProp } from './view.ts'

const focusVideoNoteChild = async (
  noteId: string,
  uiStateBlock: Block,
  renderScopeId?: string,
): Promise<void> => {
  await focusBlock(uiStateBlock, noteId, {
    edit: !uiStateBlock.repo.isReadOnly,
    renderScopeId,
  })
  await uiStateBlock.set(editorSelection, {blockId: noteId, start: 0})

  if (uiStateBlock.repo.isReadOnly) return

  // Ensure a newly mounted editor receives focus even if edit mode was
  // already active before notes view opened.
  requestEditorFocus(uiStateBlock)
}

export const focusVideoNote = async (
  videoBlock: Block,
  uiStateBlock: Block,
  renderScopeId?: string,
  preferredNoteId?: string,
): Promise<string | null> => {
  const childIds = await videoBlock.childIds.load()
  const noteId = preferredNoteId && childIds.includes(preferredNoteId)
    ? preferredNoteId
    : childIds[0]

  if (noteId) {
    await focusVideoNoteChild(noteId, uiStateBlock, renderScopeId)
    return noteId
  }

  return ensureEditableVideoNoteChild(videoBlock, uiStateBlock, renderScopeId)
}

export const ensureEditableVideoNoteChild = async (
  videoBlock: Block,
  uiStateBlock: Block,
  renderScopeId?: string,
): Promise<string | null> => {
  if (videoBlock.repo.isReadOnly) return null

  const childIds = await videoBlock.childIds.load()
  if (childIds.length > 0) return null

  const newId = await videoBlock.repo.mutate.createChild({
    parentId: videoBlock.id,
    position: {kind: 'first'},
  }) as string

  if (!newId) return null

  await focusVideoNoteChild(newId, uiStateBlock, renderScopeId)
  return newId
}

export const enterVideoNotesView = async (
  videoBlock: Block,
  uiStateBlock: Block,
  renderScopeId?: string,
): Promise<void> => {
  await videoBlock.set(videoPlayerViewProp, 'notes')
  await ensureEditableVideoNoteChild(videoBlock, uiStateBlock, renderScopeId)
}
