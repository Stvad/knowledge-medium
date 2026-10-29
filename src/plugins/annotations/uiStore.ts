/**
 * Per-tab view state for comments: which blocks have their threads expanded
 * inline, which show resolved threads too, the open composers with their
 * drafts, each panel's margin state and a pending re-anchor. Deliberately ephemeral module state, never block data: a draft is
 * written only on submit, so an abandoned comment leaves nothing behind.
 *
 * Keyed by `viewKey`, one block as shown in one render scope, so expanding or
 * commenting on a block in one panel leaves the same block in another alone.
 */

import {useSyncExternalStore} from 'react'
import {CallbackSet} from '@/utils/callbackSet'
import type {RangeAnchor} from './anchor.ts'

export const viewKey = (renderScopeId: string | undefined, blockId: string): string =>
  `${renderScopeId ?? ''}\u0000${blockId}`

export interface ComposerState {
  targetId: string
  /** null comments on the whole block. */
  anchor: RangeAnchor | null
  draft: string
  error: string | null
  /** A submit is in flight; another one would write the same draft twice. */
  submitting: boolean
}

const expanded = new Set<string>()
const showingResolved = new Set<string>()
const composers = new Map<string, ComposerState>()
const listeners = new CallbackSet('annotations-ui')

const subscribe = (listener: () => void): (() => void) => listeners.add(listener)

const toggle = (set: Set<string>, key: string): void => {
  if (set.has(key)) set.delete(key)
  else set.add(key)
  listeners.notify()
}

export const toggleThreadsExpanded = (key: string): void => toggle(expanded, key)
export const toggleShowResolved = (key: string): void => toggle(showingResolved, key)

export const useThreadsExpanded = (key: string): boolean =>
  useSyncExternalStore(subscribe, () => expanded.has(key))
export const useShowResolved = (key: string): boolean =>
  useSyncExternalStore(subscribe, () => showingResolved.has(key))

/** Open (or re-aim) a composer, keeping a draft already typed there: a submit
 *  refused because the text changed keeps the draft, and the user's next
 *  selection re-aims it. Expands the block's threads. */
export const openComposer = (key: string, targetId: string, anchor: RangeAnchor | null): void => {
  composers.set(key, {targetId, anchor, draft: composers.get(key)?.draft ?? '', error: null, submitting: false})
  expanded.add(key)
  listeners.notify()
}

/** The draft is frozen while a submit is in flight: the submit already took
 *  the text, and closes the composer when it lands, so later typing would be
 *  dropped unsaved. */
export const updateComposer = (key: string, patch: Partial<Omit<ComposerState, 'targetId'>>): void => {
  const current = composers.get(key)
  if (!current) return
  if (current.submitting && patch.draft !== undefined) return
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
const showingClosed = new Set<string>()

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

export const toggleShowClosed = (panelId: string): void => toggle(showingClosed, panelId)

export const showClosedThreads = (panelId: string): void => {
  if (showingClosed.has(panelId)) return
  showingClosed.add(panelId)
  listeners.notify()
}
export const useShowClosed = (panelId: string): boolean =>
  useSyncExternalStore(subscribe, () => showingClosed.has(panelId))

/** Every store notification, for the margin's layout pass: a card activated
 *  or a composer opened moves cards. */
export const onUiStoreChange = (listener: () => void): (() => void) => subscribe(listener)

// ──── Re-anchoring by selection ────

export interface PendingReanchor {
  threadId: string
  targetId: string
}

/** The thread waiting for the user to select its new text. One at a time:
 *  the next comment-on-selection in its target's editor re-anchors it. */
let pendingReanchor: PendingReanchor | null = null

export const startReanchor = (pending: PendingReanchor | null): void => {
  pendingReanchor = pending
  listeners.notify()
}

export const peekPendingReanchor = (): PendingReanchor | null => pendingReanchor

export const usePendingReanchor = (): PendingReanchor | null =>
  useSyncExternalStore(subscribe, () => pendingReanchor)
