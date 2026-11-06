/**
 * "The user is done editing this block" — fired when a block's editor
 * unmounts (focus moved elsewhere, edit mode exited).
 *
 * Deliberately generic and editor-owned: consumers subscribe here without
 * the editor knowing about them. It reaches this tab only; to know whether
 * a block is being edited on any device, read the synced `isEditing` flag.
 */
import { CallbackSet } from '@/utils/callbackSet.js'

export const blockEditSettled = new CallbackSet<[blockId: string]>('block-edit-settled')

export const notifyBlockEditSettled = (blockId: string): void =>
  blockEditSettled.notify(blockId)
