/**
 * Per-tab view state for comments: which blocks have their threads expanded
 * inline, which show resolved threads too, and the open composers with their
 * drafts. Deliberately ephemeral module state, never block data: a draft is
 * written only on submit, so an abandoned comment leaves nothing behind.
 */

import {useSyncExternalStore} from 'react'
import {CallbackSet} from '@/utils/callbackSet'
import type {RangeAnchor} from './anchor.ts'

export interface ComposerState {
  /** null comments on the whole block. */
  anchor: RangeAnchor | null
  draft: string
  error: string | null
}

const expanded = new Set<string>()
const showingResolved = new Set<string>()
const composers = new Map<string, ComposerState>()
const listeners = new CallbackSet('annotations-ui')

const subscribe = (listener: () => void): (() => void) => listeners.add(listener)

const toggle = (set: Set<string>, id: string): void => {
  if (set.has(id)) set.delete(id)
  else set.add(id)
  listeners.notify()
}

export const toggleThreadsExpanded = (blockId: string): void => toggle(expanded, blockId)
export const toggleShowResolved = (blockId: string): void => toggle(showingResolved, blockId)

export const useThreadsExpanded = (blockId: string): boolean =>
  useSyncExternalStore(subscribe, () => expanded.has(blockId))
export const useShowResolved = (blockId: string): boolean =>
  useSyncExternalStore(subscribe, () => showingResolved.has(blockId))

/** Open (or re-aim) the composer on `blockId`, keeping a draft already typed
 *  there: a submit refused because the text changed keeps the draft, and the
 *  user's next selection re-aims it. Expands the block's threads. */
export const openComposer = (blockId: string, anchor: RangeAnchor | null): void => {
  composers.set(blockId, {anchor, draft: composers.get(blockId)?.draft ?? '', error: null})
  expanded.add(blockId)
  listeners.notify()
}

export const updateComposer = (blockId: string, patch: Partial<ComposerState>): void => {
  const current = composers.get(blockId)
  if (!current) return
  composers.set(blockId, {...current, ...patch})
  listeners.notify()
}

export const closeComposer = (blockId: string): void => {
  if (composers.delete(blockId)) listeners.notify()
}

export const peekComposer = (blockId: string): ComposerState | undefined => composers.get(blockId)

export const useComposer = (blockId: string): ComposerState | undefined =>
  useSyncExternalStore(subscribe, () => composers.get(blockId))
