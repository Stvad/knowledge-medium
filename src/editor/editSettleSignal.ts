/**
 * "The user is done editing this block" — fired when a block's editor
 * unmounts (focus moved elsewhere, edit mode exited) or when an action
 * finishes a programmatic edit on the user's behalf.
 *
 * Deliberately generic and editor-owned: consumers (e.g. the agent
 * runtime's watch-events facility, which uses it to short-circuit its
 * settle window) subscribe here without the editor knowing about them.
 */
import { CallbackSet } from '@/utils/callbackSet.js'

export const blockEditSettled = new CallbackSet<[blockId: string]>('block-edit-settled')

export const notifyBlockEditSettled = (blockId: string): void =>
  blockEditSettled.notify(blockId)
