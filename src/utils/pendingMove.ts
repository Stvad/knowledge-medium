/**
 * Module-level store for a pending cut→paste block MOVE (issue: make
 * cut→paste a true block move instead of serialize-delete-reparse, which
 * used to mint new ids and leave every ref pointing at a tombstone).
 *
 * Shape follows `createToggleStore` (`@/utils/toggleStore.js`): a plain
 * module singleton backed by a `CallbackSet`, read with
 * `useSyncExternalStore`. Richer than a toggle (it carries WHICH blocks,
 * which workspace, and the exact clipboard text at cut time), so it's
 * hand-rolled here rather than reusing `createToggleStore` itself.
 *
 * Lives in core (`src/utils/`), not under `src/plugins/move-blocks/`,
 * because both sides that touch it are core: `cut_selected_blocks` /
 * `cut_block` (`@/shortcuts/defaultShortcuts.js`) WRITE it, and the
 * keyboard-paste actions + `BlockPasteShellDecorator` READ it (via
 * `tryPasteAsMove`, `@/paste/moveOnPasteVerb.js`) to decide whether a paste
 * completes the move. The move-blocks PLUGIN only reads it too — for the
 * dim-pending-move styling (`pendingMoveStyling.ts`) and to supply the verb
 * impl that actually calls `moveBlocksTo` — so putting the store itself in
 * core is what lets core write it without a core→plugin import.
 *
 * This is the CUT side's state only. It says nothing about whether a paste
 * will actually complete the move — `pasteAsMoveVerb` (paste-time) decides
 * that against the register's current contents.
 */
import { useSyncExternalStore } from 'react'
import { CallbackSet } from '@/utils/callbackSet.js'

export interface PendingMove {
  readonly blockIds: readonly string[]
  readonly workspaceId: string
  /** EXACTLY the markdown written to the OS clipboard at cut time. A paste
   *  whose clipboard text no longer matches this (the user copied something
   *  else, in-app or from another app) invalidates the pending move — see
   *  `pasteAsMoveVerb`. */
  readonly clipboardText: string
  /** Whether `clipboardText` actually reached the OS clipboard.
   *
   *  `navigator.clipboard.write` can be refused outright — a
   *  `NotAllowedError` for a non-secure context, a missing user gesture,
   *  or a browser with stricter clipboard rules. The cut still marks the
   *  move in that case (the register, not the clipboard, is what makes
   *  paste-as-move work), but the clipboard then holds someone else's
   *  text, so the "does the clipboard still match?" invalidation check
   *  would compare against something we never wrote and always fail —
   *  silently downgrading every paste to a duplicating text paste. When
   *  this is false, that check is skipped. */
  readonly clipboardSynced: boolean
}

let pending: PendingMove | null = null
// Cached alongside `pending` so `usePendingMoveIds`'s snapshot is reference-
// stable between calls (required by `useSyncExternalStore`) without
// re-deriving a new Set on every read.
let pendingIds: ReadonlySet<string> | null = null

const subscribers = new CallbackSet('pending-move')

export const setPendingMove = (move: PendingMove): void => {
  pending = move
  pendingIds = new Set(move.blockIds)
  subscribers.notify()
}

export const getPendingMove = (): PendingMove | null => pending

export const clearPendingMove = (): void => {
  if (pending === null) return
  pending = null
  pendingIds = null
  subscribers.notify()
}

export const subscribePendingMove = (callback: () => void): (() => void) =>
  subscribers.add(callback)

/** Reactive: the set of block ids currently marked for a pending move, or
 *  `null` when nothing is pending. Used by the move-blocks plugin's
 *  dim-pending-move styling. */
export const usePendingMoveIds = (): ReadonlySet<string> | null =>
  useSyncExternalStore(subscribePendingMove, () => pendingIds, () => null)
