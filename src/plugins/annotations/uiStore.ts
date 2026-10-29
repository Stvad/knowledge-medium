/**
 * Per-tab view state for comments: which blocks have their threads expanded
 * inline, which show resolved threads too, and the open composers with their
 * drafts. Module state like the toggle sets (`createKeyedToggleSet`), never
 * block data: a draft is written only on submit, so an abandoned comment
 * leaves nothing behind.
 *
 * Keyed by `viewKey`, one block as shown in one render scope, so expanding or
 * commenting on a block in one panel leaves the same block in another alone.
 */

import {useSyncExternalStore} from 'react'
import {CallbackSet} from '@/utils/callbackSet'
import {createKeyedToggleSet} from '@/utils/toggleStore'
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

const expanded = createKeyedToggleSet('annotations-expanded')
const showingResolved = createKeyedToggleSet('annotations-show-resolved')
const composers = new Map<string, ComposerState>()
const listeners = new CallbackSet('annotations-composers')

const subscribe = (listener: () => void): (() => void) => listeners.add(listener)

export const toggleThreadsExpanded = expanded.toggle
export const toggleShowResolved = showingResolved.toggle

export const useThreadsExpanded = expanded.useHas
export const useShowResolved = showingResolved.useHas

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
