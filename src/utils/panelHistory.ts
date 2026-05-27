// Per-panel back/forward history. In-memory, page-lifetime-local — never persisted
// or synced. Tab history has no shareable or cross-device meaning, and
// loses meaning past page close, so this is the canonical case for the
// "ephemeral session state" carve-out from the otherwise-everything-in-DB
// model. The current displayed block lives on the panel block as
// topLevelBlockIdProp; the back/forward stacks live here.
//
// Each entry on a stack carries a snapshot of the panel's ephemeral state
// at the moment we navigated away from it (focused block, scroll
// position, etc.). On back/forward we restore that snapshot so revisits
// pick up exactly where the user left them — same affordance browsers
// give tabs via bfcache. The capture happens via a snapshotter callback
// the panel renderer registers; the restore is queued for the renderer's
// next post-navigation effect.
//
// Browser-tab semantics: pushing a new entry clears forward; calling
// back() peeks the current entry, pushes it onto forward, and pops the
// most recent back entry as the destination. Caller is responsible for
// actually mutating panel state to land on that destination — the store
// is pure bookkeeping.

import { useSyncExternalStore } from 'react'
import type { Block } from '@/data/block'
import { ChangeScope } from '@/data/api'
import {
  focusedBlockIdProp,
  focusedBlockLocationProp,
  type FocusedBlockLocation,
  scrollTopProp,
  topLevelBlockIdProp,
} from '@/data/properties'
import { outlineRenderScopeId } from '@/utils/renderScope'
import { CallbackSet } from '@/utils/callbackSet'
import { withMoveTransition } from '@/utils/viewTransition'

/** Per-(panel, block-visit) ephemeral state captured at navigation time
 *  and replayed on back/forward. New fields can be added freely; consumers
 *  read them defensively (snapshot may be undefined or partial). */
export interface VisitState {
  focusedLocation?: FocusedBlockLocation
  scrollTop?: number
}

export interface HistoryEntry {
  blockId: string
  state?: VisitState
}

interface PanelHistoryState {
  back: readonly HistoryEntry[]
  forward: readonly HistoryEntry[]
}

const EMPTY: PanelHistoryState = {back: [], forward: []}

export class PanelHistoryStore {
  private state = new Map<string, PanelHistoryState>()
  private readonly listeners = new Map<string, CallbackSet<[]>>()
  private readonly snapshotters = new Map<string, () => VisitState | undefined>()
  private readonly pendingRestore = new Map<string, VisitState>()

  getSnapshot = (panelId: string): PanelHistoryState =>
    this.state.get(panelId) ?? EMPTY

  subscribe = (panelId: string, listener: () => void): (() => void) => {
    let set = this.listeners.get(panelId)
    if (!set) {
      set = new CallbackSet(`PanelHistory[${panelId}]`)
      this.listeners.set(panelId, set)
    }
    const off = set.add(listener)
    return () => {
      off()
      // Identity-guard the bucket drop: a double-unsubscribe could
      // otherwise nuke a fresh bucket that a re-subscribe installed
      // for the same panelId in between.
      if (set.size === 0 && this.listeners.get(panelId) === set) {
        this.listeners.delete(panelId)
      }
    }
  }

  /** Record a transition: about to leave `entry`. Pushes onto back,
   *  clears forward (browser-tab semantics — once you navigate after
   *  going back, the previously-popped forward chain is gone). */
  push(panelId: string, entry: HistoryEntry): void {
    const current = this.state.get(panelId) ?? EMPTY
    const lastBack = current.back[current.back.length - 1]
    if (lastBack?.blockId === entry.blockId && current.forward.length === 0) return
    this.state.set(panelId, {
      back: [...current.back, entry],
      forward: [],
    })
    this.notify(panelId)
  }

  /** Pop the most recent back entry. Pushes `currentEntry` onto forward
   *  so a subsequent forward() can return to it. Returns the destination
   *  entry, or null if the back stack is empty. */
  back(panelId: string, currentEntry: HistoryEntry): HistoryEntry | null {
    const current = this.state.get(panelId) ?? EMPTY
    if (current.back.length === 0) return null
    const next = current.back[current.back.length - 1]
    this.state.set(panelId, {
      back: current.back.slice(0, -1),
      forward: [...current.forward, currentEntry],
    })
    this.notify(panelId)
    return next
  }

  forward(panelId: string, currentEntry: HistoryEntry): HistoryEntry | null {
    const current = this.state.get(panelId) ?? EMPTY
    if (current.forward.length === 0) return null
    const next = current.forward[current.forward.length - 1]
    this.state.set(panelId, {
      back: [...current.back, currentEntry],
      forward: current.forward.slice(0, -1),
    })
    this.notify(panelId)
    return next
  }

  reconcileUrlNavigation(
    panelId: string,
    currentEntry: HistoryEntry,
    targetBlockId: string,
  ): HistoryEntry | null {
    const current = this.state.get(panelId) ?? EMPTY
    const backTop = current.back[current.back.length - 1]
    if (backTop?.blockId === targetBlockId) {
      this.state.set(panelId, {
        back: current.back.slice(0, -1),
        forward: [...current.forward, currentEntry],
      })
      this.notify(panelId)
      return backTop
    }

    const forwardTop = current.forward[current.forward.length - 1]
    if (forwardTop?.blockId === targetBlockId) {
      this.state.set(panelId, {
        back: [...current.back, currentEntry],
        forward: current.forward.slice(0, -1),
      })
      this.notify(panelId)
      return forwardTop
    }

    if (current.back.length > 0 || current.forward.length > 0) {
      this.state.delete(panelId)
      this.notify(panelId)
    }
    return null
  }

  clear(panelId: string): void {
    const had = this.state.has(panelId)
    this.state.delete(panelId)
    this.pendingRestore.delete(panelId)
    if (had) this.notify(panelId)
  }

  /** Register a snapshotter for a panel — a function that reads the
   *  panel's current ephemeral state (focused block, scroll, …) so the
   *  store can capture it before the panel navigates. Returns an
   *  unsubscribe function; multiple registrations replace each other so
   *  remounts are safe. */
  registerSnapshotter(panelId: string, fn: () => VisitState | undefined): () => void {
    this.snapshotters.set(panelId, fn)
    return () => {
      // Only delete if this registration is still the current one — a
      // remount may have already replaced us. Comparing by identity keeps
      // the unsubscribe order-independent.
      if (this.snapshotters.get(panelId) === fn) this.snapshotters.delete(panelId)
    }
  }

  /** Invoke the registered snapshotter for a panel, returning whatever
   *  state it captured. Undefined if no snapshotter is registered (e.g.
   *  panel not mounted) — push() will store the entry without state. */
  snapshot(panelId: string): VisitState | undefined {
    const fn = this.snapshotters.get(panelId)
    return fn?.()
  }

  /** Queue a restore for the next time the panel renderer applies state.
   *  Used by back/forward to hand the popped entry's snapshot to the
   *  renderer; the renderer's post-navigation effect drains it. */
  enqueueRestore(panelId: string, state: VisitState | undefined): void {
    if (!state) {
      this.pendingRestore.delete(panelId)
      return
    }
    this.pendingRestore.set(panelId, state)
  }

  consumeRestore(panelId: string): VisitState | undefined {
    const state = this.pendingRestore.get(panelId)
    if (state) this.pendingRestore.delete(panelId)
    return state
  }

  private notify(panelId: string): void {
    this.listeners.get(panelId)?.notify()
  }
}

export const panelHistory = new PanelHistoryStore()

/** Navigate within a panel: capture the current visit's ephemeral state,
 *  push (block, state) onto back, clear forward, then mutate the panel's
 *  top-level block. No-op when `blockId` already equals the current
 *  top-level. */
export const navigateInPanel = async (
  panelBlock: Block,
  blockId: string,
): Promise<void> => {
  const prev = panelBlock.peekProperty(topLevelBlockIdProp)
  if (prev === blockId) return
  if (prev) {
    panelHistory.push(panelBlock.id, {
      blockId: prev,
      state: panelHistory.snapshot(panelBlock.id),
    })
  }
  // Panel content fully swaps here — the highest-impact transition in
  // the app. Centralised so every navigation path (zoom shortcuts,
  // wikilink clicks, breadcrumb, programmatic) gets the same crossfade
  // without each call site re-wrapping.
  await withMoveTransition(async () => {
    await panelBlock.repo.tx(async tx => {
      await tx.setProperty(panelBlock.id, topLevelBlockIdProp, blockId)
      await tx.setProperty(panelBlock.id, focusedBlockLocationProp, {
        blockId,
        renderScopeId: outlineRenderScopeId(blockId),
      })
      await tx.setProperty(panelBlock.id, focusedBlockIdProp, undefined)
      await tx.setProperty(panelBlock.id, scrollTopProp, 0)
    }, {scope: ChangeScope.UiState, description: 'navigate in panel'})
  })
}

/** Step the panel one entry back. Captures the current visit's state
 *  onto forward, then queues the destination's snapshot for the renderer
 *  to restore (focused block, scroll position) on its next effect. */
export const goBackInPanel = async (panelBlock: Block): Promise<boolean> => {
  const current = panelBlock.peekProperty(topLevelBlockIdProp)
  if (!current) return false
  const dest = panelHistory.back(panelBlock.id, {
    blockId: current,
    state: panelHistory.snapshot(panelBlock.id),
  })
  if (!dest) return false
  panelHistory.enqueueRestore(panelBlock.id, dest.state)
  // Focused block restores synchronously in the same UiState tx so the
  // first render of the new top-level already has the right cursor.
  // Scroll restore needs the new content to render first; that's the
  // renderer's responsibility via consumeRestore() in a post-render effect.
  await withMoveTransition(async () => {
    await panelBlock.repo.tx(async tx => {
      await tx.setProperty(panelBlock.id, topLevelBlockIdProp, dest.blockId)
      await tx.setProperty(panelBlock.id, focusedBlockLocationProp, dest.state?.focusedLocation ?? {
        blockId: dest.blockId,
        renderScopeId: outlineRenderScopeId(dest.blockId),
      })
      await tx.setProperty(panelBlock.id, focusedBlockIdProp, undefined)
      await tx.setProperty(panelBlock.id, scrollTopProp, dest.state?.scrollTop ?? 0)
    }, {scope: ChangeScope.UiState, description: 'panel history back'})
  })
  return true
}

export const goForwardInPanel = async (panelBlock: Block): Promise<boolean> => {
  const current = panelBlock.peekProperty(topLevelBlockIdProp)
  if (!current) return false
  const dest = panelHistory.forward(panelBlock.id, {
    blockId: current,
    state: panelHistory.snapshot(panelBlock.id),
  })
  if (!dest) return false
  panelHistory.enqueueRestore(panelBlock.id, dest.state)
  await withMoveTransition(async () => {
    await panelBlock.repo.tx(async tx => {
      await tx.setProperty(panelBlock.id, topLevelBlockIdProp, dest.blockId)
      await tx.setProperty(panelBlock.id, focusedBlockLocationProp, dest.state?.focusedLocation ?? {
        blockId: dest.blockId,
        renderScopeId: outlineRenderScopeId(dest.blockId),
      })
      await tx.setProperty(panelBlock.id, focusedBlockIdProp, undefined)
      await tx.setProperty(panelBlock.id, scrollTopProp, dest.state?.scrollTop ?? 0)
    }, {scope: ChangeScope.UiState, description: 'panel history forward'})
  })
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
