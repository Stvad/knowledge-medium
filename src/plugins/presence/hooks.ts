/** React bindings over the presence store. */
import { useSyncExternalStore } from 'react'
import { presenceClient } from './presenceClient.js'
import type { RemoteCursor } from './types.js'

const EMPTY_CURSORS: readonly RemoteCursor[] = []

/** The `,`-joined peer colours occupying `blockId` (or `''`). Primitive, so
 *  only blocks whose occupancy changed re-render. */
export const useRemoteSelectionColorKey = (blockId: string): string =>
  useSyncExternalStore(
    presenceClient.subscribePresence,
    () => presenceClient.selectionColorKey(blockId),
    () => '',
  )

/** All remote mouse cursors (already excludes self). */
export const useRemoteCursors = (): readonly RemoteCursor[] =>
  useSyncExternalStore(
    presenceClient.subscribeCursors,
    presenceClient.getCursors,
    () => EMPTY_CURSORS,
  )
