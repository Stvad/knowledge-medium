// Per-panel back/forward history. In-memory, tab-local — never persisted
// or synced. Tab history has no shareable or cross-device meaning, and
// loses meaning past tab close, so this is the canonical case for the
// "ephemeral session state" carve-out from the otherwise-everything-in-DB
// model. The current displayed block lives on the panel block as
// topLevelBlockIdProp; the back/forward stacks live here.
//
// Browser-tab semantics: pushing a new entry clears forward; calling
// back() peeks the current block, pushes it onto forward, and pops the
// most recent back entry as the destination. Caller is responsible for
// actually mutating panel state to land on that destination — the store
// is pure bookkeeping.

import { useSyncExternalStore } from 'react'
import type { Block } from '@/data/block'
import { topLevelBlockIdProp } from '@/data/properties'

interface PanelHistoryState {
  back: readonly string[]
  forward: readonly string[]
}

const EMPTY: PanelHistoryState = {back: [], forward: []}

export class PanelHistoryStore {
  private state = new Map<string, PanelHistoryState>()
  private readonly listeners = new Map<string, Set<() => void>>()

  getSnapshot = (panelId: string): PanelHistoryState =>
    this.state.get(panelId) ?? EMPTY

  subscribe = (panelId: string, listener: () => void): (() => void) => {
    const set = this.listeners.get(panelId) ?? new Set()
    set.add(listener)
    this.listeners.set(panelId, set)
    return () => {
      const current = this.listeners.get(panelId)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) this.listeners.delete(panelId)
    }
  }

  /** Record a transition: about to leave `prevBlockId`. Pushes onto back,
   *  clears forward (browser-tab semantics — once you navigate after
   *  going back, the previously-popped forward chain is gone). */
  push(panelId: string, prevBlockId: string): void {
    const current = this.state.get(panelId) ?? EMPTY
    const lastBack = current.back[current.back.length - 1]
    if (lastBack === prevBlockId && current.forward.length === 0) return
    this.state.set(panelId, {
      back: [...current.back, prevBlockId],
      forward: [],
    })
    this.notify(panelId)
  }

  /** Pop the most recent back entry. Pushes `currentBlockId` onto forward
   *  so a subsequent forward() can return to it. Returns the destination
   *  block id, or null if the back stack is empty. */
  back(panelId: string, currentBlockId: string): string | null {
    const current = this.state.get(panelId) ?? EMPTY
    if (current.back.length === 0) return null
    const next = current.back[current.back.length - 1]
    this.state.set(panelId, {
      back: current.back.slice(0, -1),
      forward: [...current.forward, currentBlockId],
    })
    this.notify(panelId)
    return next
  }

  forward(panelId: string, currentBlockId: string): string | null {
    const current = this.state.get(panelId) ?? EMPTY
    if (current.forward.length === 0) return null
    const next = current.forward[current.forward.length - 1]
    this.state.set(panelId, {
      back: [...current.back, currentBlockId],
      forward: current.forward.slice(0, -1),
    })
    this.notify(panelId)
    return next
  }

  clear(panelId: string): void {
    if (!this.state.has(panelId)) return
    this.state.delete(panelId)
    this.notify(panelId)
  }

  private notify(panelId: string): void {
    const listeners = this.listeners.get(panelId)
    if (!listeners) return
    for (const l of [...listeners]) l()
  }
}

export const panelHistory = new PanelHistoryStore()

/** Navigate within a panel: capture the panel's current top-level block
 *  into the back stack, then mutate it to the new destination. No-op when
 *  `blockId` already equals the current top-level. */
export const navigateInPanel = async (
  panelBlock: Block,
  blockId: string,
): Promise<void> => {
  const prev = panelBlock.peekProperty(topLevelBlockIdProp)
  if (prev === blockId) return
  if (prev) panelHistory.push(panelBlock.id, prev)
  await panelBlock.set(topLevelBlockIdProp, blockId)
}

/** Step the panel one entry back. Returns true if a navigation occurred. */
export const goBackInPanel = async (panelBlock: Block): Promise<boolean> => {
  const current = panelBlock.peekProperty(topLevelBlockIdProp)
  if (!current) return false
  const dest = panelHistory.back(panelBlock.id, current)
  if (!dest) return false
  await panelBlock.set(topLevelBlockIdProp, dest)
  return true
}

export const goForwardInPanel = async (panelBlock: Block): Promise<boolean> => {
  const current = panelBlock.peekProperty(topLevelBlockIdProp)
  if (!current) return false
  const dest = panelHistory.forward(panelBlock.id, current)
  if (!dest) return false
  await panelBlock.set(topLevelBlockIdProp, dest)
  return true
}

/** React hook surfacing per-panel back/forward availability for UI
 *  affordances. Re-renders the consumer when the panel's stack changes. */
export const usePanelHistory = (panelId: string): {
  canBack: boolean
  canForward: boolean
} => {
  const state = useSyncExternalStore(
    listener => panelHistory.subscribe(panelId, listener),
    () => panelHistory.getSnapshot(panelId),
    () => EMPTY,
  )
  return {
    canBack: state.back.length > 0,
    canForward: state.forward.length > 0,
  }
}
