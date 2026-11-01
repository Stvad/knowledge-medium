/**
 * Per-tab view state for comments. Module state like the toggle sets
 * (`createKeyedToggleSet`), never block data: a draft is written only on
 * submit, so an abandoned comment leaves nothing behind.
 *
 * - Inline threads, resolved threads shown and open composers are keyed by
 *   `viewKey`, one block as shown in one render scope, so expanding or
 *   commenting on a block in one panel leaves the same block in another alone.
 * - The margin's state is keyed by panel.
 * - A pending re-anchor is one for the tab.
 */

import {useSyncExternalStore} from 'react'
import {CallbackSet} from '@/utils/callbackSet'
import {surfaceRenderScopeId} from '@/utils/renderScope'
import {createKeyedToggleSet} from '@/utils/toggleStore'
import type {RangeAnchor} from './anchor.ts'

export const viewKey = (renderScopeId: string | undefined, blockId: string): string =>
  `${renderScopeId ?? ''}\u0000${blockId}`

/** Where a thread's card renders: inline under its block, or in the panel's
 *  margin. */
export type CardSurface = 'comments' | 'margin'

/** A card's render scope, derived from the scope it renders in. The one
 *  definition: a card renders in it, and a navigation focuses into it. */
export const cardRenderScopeId = (surface: CardSurface, parentRenderScopeId: string, threadId: string): string =>
  surfaceRenderScopeId(surface, parentRenderScopeId, threadId)

export interface ComposerState {
  targetId: string
  /** null comments on the whole block. */
  anchor: RangeAnchor | null
  draft: string
  /** Present for an edit suggestion: the text to replace the quote with. */
  replacement?: string
  error: string | null
  /** A submit is in flight; another one would write the same draft twice. */
  submitting: boolean
}

const expanded = createKeyedToggleSet('annotations-expanded')
const showingResolved = createKeyedToggleSet('annotations-show-resolved')
const composers = new Map<string, ComposerState>()
const listeners = new CallbackSet('annotations-ui')

const subscribe = (listener: () => void): (() => void) => listeners.add(listener)

export const toggleThreadsExpanded = expanded.toggle
export const toggleShowResolved = showingResolved.toggle

export const useThreadsExpanded = expanded.useHas
export const useShowResolved = showingResolved.useHas

/** A replacement the user changed from its prefill (the quote), worth keeping
 *  across a re-aim; an untouched prefill follows the new quote. */
const editedReplacement = (current: ComposerState | undefined): string | undefined =>
  current?.replacement !== current?.anchor?.quote ? current?.replacement : undefined

/** Open (or re-aim) a composer, keeping a draft already typed there: a submit
 *  refused because the text changed keeps the draft, and the user's next
 *  selection re-aims it. A suggestion's replacement is kept the same way once
 *  edited, and otherwise starts as `replacement`. Expands the block's
 *  threads. */
export const openComposer = (
  key: string,
  targetId: string,
  anchor: RangeAnchor | null,
  {replacement}: {replacement?: string} = {},
): void => {
  const current = composers.get(key)
  composers.set(key, {
    targetId,
    anchor,
    draft: current?.draft ?? '',
    replacement: replacement === undefined ? undefined : editedReplacement(current) ?? replacement,
    error: null,
    submitting: false,
  })
  expanded.add(key)
  listeners.notify()
}

/** The text is frozen while a submit is in flight: the submit already took
 *  it, and closes the composer when it lands, so later typing would be
 *  dropped unsaved. */
export const updateComposer = (key: string, patch: Partial<Omit<ComposerState, 'targetId'>>): void => {
  const current = composers.get(key)
  if (!current) return
  if (current.submitting && (patch.draft !== undefined || patch.replacement !== undefined)) return
  composers.set(key, {...current, ...patch})
  listeners.notify()
}

export const closeComposer = (key: string): void => {
  if (composers.delete(key)) listeners.notify()
}

export const peekComposer = (key: string): ComposerState | undefined => composers.get(key)

export const useComposer = (key: string): ComposerState | undefined =>
  useSyncExternalStore(subscribe, () => composers.get(key))

// ──── The side margin, per panel ────

/** Panels whose margin is drawn right now: switched on AND wide enough. Their
 *  pills hand threads to the margin instead of expanding them inline. */
const marginShowing = new Set<string>()
/** The thread whose card is pinned to its anchor in each panel's margin. */
const activeThreads = new Map<string, string>()
const showingClosed = createKeyedToggleSet('annotations-show-closed')
const showingMentions = createKeyedToggleSet('annotations-show-mentions')

export const setMarginShowing = (panelId: string, showing: boolean): void => {
  if (marginShowing.has(panelId) === showing) return
  if (showing) marginShowing.add(panelId)
  else marginShowing.delete(panelId)
  listeners.notify()
}

export const useMarginShowing = (panelId: string | undefined): boolean =>
  useSyncExternalStore(subscribe, () => panelId !== undefined && marginShowing.has(panelId))

export const activateThread = (panelId: string, threadId: string): void => {
  if (activeThreads.get(panelId) === threadId) return
  activeThreads.set(panelId, threadId)
  listeners.notify()
}

export const peekActiveThread = (panelId: string): string | undefined => activeThreads.get(panelId)

export const useActiveThread = (panelId: string): string | undefined =>
  useSyncExternalStore(subscribe, () => activeThreads.get(panelId))

export const toggleShowClosed = showingClosed.toggle
export const showClosedThreads = showingClosed.add
export const useShowClosed = showingClosed.useHas
export const toggleShowMentions = showingMentions.toggle
export const useShowMentions = showingMentions.useHas

export const peekMarginShowing = (panelId: string): boolean => marginShowing.has(panelId)

/** Show `threadId`'s card for the block that `key` names in `panelId`: pinned
 *  in the margin, and expanded inline for when the margin isn't drawn, with
 *  closed threads shown if it is closed. */
export const revealThread = (panelId: string, key: string, threadId: string, open: boolean): void => {
  expanded.add(key)
  if (!open) {
    showingResolved.add(key)
    showingClosed.add(panelId)
  }
  activateThread(panelId, threadId)
}

/** The notifications that move cards without mounting or unmounting one, for
 *  the margin's layout pass: a card activated, a composer opened. */
export const onUiStoreChange = (listener: () => void): (() => void) => subscribe(listener)

// ──── Re-anchoring by selection ────

export interface PendingReanchor {
  threadId: string
  targetId: string
}

/** The thread waiting for the user to select its new text. One at a time:
 *  the next comment-on-selection in its target's editor re-anchors it. It
 *  lives only as long as the card that shows it (`releasePendingReanchor`). */
let pendingReanchor: PendingReanchor | null = null

export const startReanchor = (pending: PendingReanchor | null): void => {
  pendingReanchor = pending
  listeners.notify()
}

export const peekPendingReanchor = (): PendingReanchor | null => pendingReanchor

/** For the cue that shows a pending re-anchor, as it goes away (its card
 *  closed, or the thread no longer needs moving): the pending state goes with
 *  it, so a later comment-on-selection can't move the thread unseen. Unless
 *  it has moved on to another thread since. */
export const releasePendingReanchor = (threadId: string): void => {
  if (pendingReanchor?.threadId === threadId) startReanchor(null)
}

export const usePendingReanchor = (): PendingReanchor | null =>
  useSyncExternalStore(subscribe, () => pendingReanchor)
