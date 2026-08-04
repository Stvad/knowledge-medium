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
import { ChangeScope, type Tx } from '@/data/api'
import {
  focusedBlockLocationProp,
  type FocusedBlockLocation,
  normalizeViewMode,
  panelViewModeProp,
  scrollTopProp,
  topLevelBlockIdProp,
} from '@/data/properties'
import { panelRenderScopeId } from '@/utils/renderScope'
import { CallbackSet } from '@/utils/callbackSet'
import { withMoveTransition } from '@/utils/viewTransition'
import { isBlockTombstoned } from '@/data/blockLiveness'

/** Per-(panel, block-visit) ephemeral state captured at navigation time
 *  and replayed on back/forward. New fields can be added freely; consumers
 *  read them defensively (snapshot may be undefined or partial). */
export interface VisitState {
  focusedLocation?: FocusedBlockLocation
  scrollTop?: number
  /** The pane's view mode during this visit (`panelViewModeProp` at capture
   *  time). Applied ONLY on chevron back/forward restore — URL-driven
   *  restores take the mode from the hash's slot context instead (the URL
   *  is authoritative there; see `WritePanelContentOptions.viewMode`). */
  viewMode?: string
}

export interface HistoryEntry {
  blockId: string
  state?: VisitState
  /** Present when this entry was pushed by an enter-with-navigation
   *  (`navigateInPanel` with a `viewMode`): this entry is where the enter
   *  gesture left FROM — going back restores the pre-enter context. Only
   *  recorded here; `closeVideoNotesView` (src/plugins/video-player/notes.ts)
 *  consumes it.
   *
   *  Invariant: the marker rides the ENTRY PAIR across any number of
   *  back/forward round trips (chevron or browser-driven) — back() carries
   *  it onto the forward reconstruction, forward() re-stamps the entry it
   *  pushes back onto the back stack. Without that, enter → back → forward
   *  would leave the re-entered visit unmarked and close would strand the
   *  pane on the entered block instead of going back. */
  viewModeEnter?: string
}

interface PanelHistoryState {
  back: readonly HistoryEntry[]
  forward: readonly HistoryEntry[]
}

const EMPTY: PanelHistoryState = {back: [], forward: []}

/** Carry the enter marker from the entry being consumed onto the entry
 *  reconstructed on the opposite stack (the `viewModeEnter` invariant). */
const withCarriedEnterMark = (entry: HistoryEntry, consumed: HistoryEntry): HistoryEntry =>
  consumed.viewModeEnter ? {...entry, viewModeEnter: consumed.viewModeEnter} : entry

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
      // Carry the enter marker onto the forward reconstruction so the pair
      // stays stamped across round trips (see HistoryEntry.viewModeEnter).
      forward: [...current.forward, withCarriedEnterMark(currentEntry, next)],
    })
    this.notify(panelId)
    return next
  }

  forward(panelId: string, currentEntry: HistoryEntry): HistoryEntry | null {
    const current = this.state.get(panelId) ?? EMPTY
    if (current.forward.length === 0) return null
    const next = current.forward[current.forward.length - 1]
    this.state.set(panelId, {
      back: [...current.back, withCarriedEnterMark(currentEntry, next)],
      forward: current.forward.slice(0, -1),
    })
    this.notify(panelId)
    return next
  }

  /** The most recent entry on one of a panel's stacks, without consuming it. */
  peek(panelId: string, side: 'back' | 'forward'): HistoryEntry | null {
    const current = this.state.get(panelId)
    if (!current) return null
    const stack = current[side]
    return stack[stack.length - 1] ?? null
  }

  /** Pop the most recent entry off one of a panel's stacks and DISCARD it —
   *  no reconstruction on the opposite stack. Unlike `back()`/`forward()` this
   *  is not a user navigation: it's how a caller consumes a destination it
   *  reached some other way (content recovery), and how a dead entry is
   *  dropped (`pruneDeadTop`). Parking either kind on the opposite stack would
   *  just re-expose it to the other chevron.
   *
   *  Pass `expected` to make the drop compare-and-swap: callers that decided
   *  to drop after an `await` would otherwise discard whatever a concurrent
   *  navigation pushed in the meantime instead of the entry they inspected.
   *  Returns whether an entry was actually dropped. */
  dropTop(panelId: string, side: 'back' | 'forward', expected?: HistoryEntry): boolean {
    const current = this.state.get(panelId)
    if (!current || current[side].length === 0) return false
    if (expected !== undefined && current[side][current[side].length - 1] !== expected) return false
    this.state.set(panelId, side === 'back'
      ? {back: current.back.slice(0, -1), forward: current.forward}
      : {back: current.back, forward: current.forward.slice(0, -1)})
    this.notify(panelId)
    return true
  }

  /** What {@link reconcileUrlNavigation} WOULD return, without mutating —
   *  the peek half of the staged (write-ahead) protocol for transactional
   *  callers: peek inside the repo.tx for the row writes, then hand the
   *  panel's state ref to {@link commitUrlNavigation} after the tx commits
   *  (an abort then has nothing to undo; see reconcilePanelRows). */
  peekUrlNavigation(panelId: string, targetBlockId: string): HistoryEntry | null {
    const backTop = this.peek(panelId, 'back')
    if (backTop?.blockId === targetBlockId) return backTop
    const forwardTop = this.peek(panelId, 'forward')
    if (forwardTop?.blockId === targetBlockId) return forwardTop
    return null
  }

  /** Commit half of the staged protocol: run the real reconcile +
   *  pending-restore write, but ONLY if the panel's state is still the
   *  `stagedAt` ref captured at peek time (state objects are immutable and
   *  replaced wholesale on every mutation, so the ref doubles as a version
   *  stamp). A concurrent navigation that landed while the tx was
   *  suspended replaced the ref — it WINS: running the reconcile anyway
   *  would hit its no-match wipe branch and delete the concurrent entry,
   *  and the stale restore would replay another epoch's scroll/focus. */
  commitUrlNavigation(
    panelId: string,
    currentEntry: HistoryEntry | null,
    targetBlockId: string,
    stagedAt: PanelHistoryState,
  ): void {
    if (this.getSnapshot(panelId) !== stagedAt) return
    const committed = currentEntry ? this.reconcileUrlNavigation(panelId, currentEntry, targetBlockId) : null
    this.enqueueRestore(panelId, committed?.state)
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
        // Same enter-marker carry as back()/forward(): browser-driven round
        // trips must not strip the stamp either.
        forward: [...current.forward, withCarriedEnterMark(currentEntry, backTop)],
      })
      this.notify(panelId)
      return backTop
    }

    const forwardTop = current.forward[current.forward.length - 1]
    if (forwardTop?.blockId === targetBlockId) {
      this.state.set(panelId, {
        back: [...current.back, withCarriedEnterMark(currentEntry, forwardTop)],
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

/**
 * Blocks recovery has POSITIVELY confirmed deleted this session.
 *
 * Exists because the cache can't answer the question: `repo.load` marks any row
 * it can't find as missing, which covers "deleted" and "hasn't replicated yet"
 * alike, and `PanelContentRecovery` calls `load()` on precisely the ambiguous
 * ones. Consumers that must not guess wrong — the layout projection deciding
 * whether a hash entry is worth keeping in browser history — ask here instead
 * of inferring from that marker.
 *
 * WRITE-ONCE. Recovery records an id here and nothing ever removes it.
 *
 * The lifetime can't be scoped to the recovery write, tempting as that is: the
 * projection learns about the commit through a loader-backed query
 * subscription, which fires only after the loader re-resolves — well after
 * `transactPanelContent` has resolved. So a release in a `finally` (or any
 * refcount over the in-flight window) would be gone before the only reader
 * looks.
 *
 * Retraction was tried and is worse than the disease. Removing an id when a
 * pane observed the block live again, or when a recovery write failed, meant
 * one pane could drop a mark another pane was still relying on — two panes on
 * the same page recover concurrently, and the loser's commit then PUSHED a
 * history entry rendering a tombstone instead of replacing it. Two review
 * rounds found two different versions of that race. Write-once has none of it.
 *
 * What write-once costs: a page restored by undo stays recorded, so navigating
 * a pane off it replaces rather than pushes one history entry. That is one
 * skipped Back step in an already-exceptional flow — cheap next to a Back
 * button that lands on a deleted page. Ids only, bounded by the deletes one
 * session actually recovered from, never persisted.
 */
const confirmedDeletedBlockIds = new Set<string>()

export const markBlockConfirmedDeleted = (blockId: string): void => {
  confirmedDeletedBlockIds.add(blockId)
}

export const isBlockConfirmedDeleted = (blockId: string): boolean =>
  confirmedDeletedBlockIds.has(blockId)

/** Module-global state outlives a test's DB reset, and suites reuse block ids
 *  across cases — so a delete in one case would otherwise still read as
 *  confirmed-dead in the next. Production never needs this (ids are uuids and
 *  the set dies with the page). */
export const __resetConfirmedDeletedForTesting = (): void => {
  confirmedDeletedBlockIds.clear()
}

export interface WritePanelContentOptions {
  /** The pane's view mode AFTER this write. Defaults to undefined = CLEAR:
   *  a view mode belongs to the (pane, block) pair, so navigating the pane
   *  away must not leak the mode onto the next block. Each caller decides
   *  the source — `navigateInPanel` passes its own option, chevrons pass
   *  the restored `VisitState.viewMode`, URL reconcile passes the hash's
   *  slot context (never `VisitState` — the URL is authoritative there). */
  viewMode?: string
}

/** Write a panel's content: point `panelId` at `blockId` and set its focus +
 *  scroll + view mode. With `state` (a back/forward or URL-reconcile restore)
 *  it replays the captured focus/scroll; without it the view is fresh — focus
 *  the new top-level, scroll to 0. The single choke for content *swaps on an
 *  existing panel row* — in-panel navigate, back/forward, URL reconcile, merge
 *  retarget; a *newly created* row's initial content is set by
 *  `createPanelRowInTx` instead, so a complete "observe every view" seam would
 *  hook both. Takes the caller's `tx`, so it composes inside a batch reconcile
 *  as well as a single interactive swap. */
export const writePanelContent = async (
  tx: Tx,
  panelId: string,
  blockId: string,
  state?: VisitState,
  options: WritePanelContentOptions = {},
): Promise<void> => {
  // Guard the mode write behind a DECODED compare (absent ≡ null ≡ ''): the
  // engine's own write dedup compares ENCODED values, where absent ≠ null
  // (optionalString.encode(undefined) = null) — so an unguarded clear would
  // materialize panelViewMode:null on every never-moded pane.
  const currentMode = normalizeViewMode(await tx.getProperty(panelId, panelViewModeProp))
  const nextMode = normalizeViewMode(options.viewMode)
  await tx.setProperty(panelId, topLevelBlockIdProp, blockId)
  if (currentMode !== nextMode) {
    await tx.setProperty(panelId, panelViewModeProp, nextMode)
  }
  await tx.setProperty(panelId, focusedBlockLocationProp, state?.focusedLocation ?? {
    blockId,
    renderScopeId: panelRenderScopeId(panelId, blockId),
  })
  await tx.setProperty(panelId, scrollTopProp, state?.scrollTop ?? 0)
}

/** Swap a panel's content in its own UiState tx, wrapped in the crossfade —
 *  the interactive path (navigate / back / forward). Focus restores
 *  synchronously here so the first render of the new top-level already has the
 *  right cursor; scroll restore needs the new content rendered first and is
 *  handled by the renderer via `consumeRestore()` in a post-render effect. */
const transactPanelContent = (
  panelBlock: Block,
  blockId: string,
  state: VisitState | undefined,
  description: string,
  options?: WritePanelContentOptions,
): Promise<void> =>
  withMoveTransition(async () => {
    await panelBlock.repo.tx(async tx => {
      await writePanelContent(tx, panelBlock.id, blockId, state, options)
    }, {scope: ChangeScope.UiState, description})
  })

export interface NavigateInPanelOptions {
  /** Enter-with-navigation: land on `blockId` already in this view mode —
   *  one tx (one projection push) and one history entry, stamped
   *  `viewModeEnter`. A two-step fallback (navigate, then set the mode)
   *  would project two nondeterministic hash entries. */
  viewMode?: string
}

/** Navigate within a panel: capture the current visit's ephemeral state, push
 *  (block, state) onto back, clear forward, then swap the panel's top-level
 *  block.
 *
 *  Same-block calls are NOT navigations. A plain call (no `viewMode` key)
 *  is a pure no-op — the mode belongs to the (pane, block) pair, and a
 *  re-navigation to the same block changes neither, so zoom-in / re-clicking
 *  the open block must not disturb an active mode. Only when the caller
 *  EXPLICITLY passes `viewMode` (including `{viewMode: undefined}`, the
 *  clear-only form) does the call run a MODE-ONLY tx (the primary enter
 *  gesture — entering notes on the currently-shown block). No history entry
 *  and no `viewModeEnter` stamp in that case: there is no pre-enter content
 *  to go back to, so a later close correctly clears the mode instead of
 *  navigating away.
 *
 *  The panel content fully swaps here — the highest-impact transition in the
 *  app — centralised so every navigation path (zoom shortcuts, wikilink clicks,
 *  breadcrumb, programmatic) gets the same crossfade without re-wrapping. */
export const navigateInPanel = async (
  panelBlock: Block,
  blockId: string,
  options: NavigateInPanelOptions = {},
): Promise<void> => {
  const prev = panelBlock.peekProperty(topLevelBlockIdProp)
  if (prev === blockId) {
    // Presence-gated: a plain same-block call preserves the mode; only an
    // explicit viewMode key (set OR undefined-to-clear) touches it.
    if (!('viewMode' in options)) return
    const currentMode = normalizeViewMode(panelBlock.peekProperty(panelViewModeProp))
    const nextMode = normalizeViewMode(options.viewMode)
    if (currentMode === nextMode) return
    await panelBlock.repo.tx(async tx => {
      await tx.setProperty(panelBlock.id, panelViewModeProp, nextMode)
    }, {scope: ChangeScope.UiState, description: 'set panel view mode'})
    return
  }
  if (prev) {
    panelHistory.push(panelBlock.id, {
      blockId: prev,
      state: panelHistory.snapshot(panelBlock.id),
      ...(normalizeViewMode(options.viewMode) ? {viewModeEnter: options.viewMode} : {}),
    })
  }
  await transactPanelContent(panelBlock, blockId, undefined, 'navigate in panel', {viewMode: options.viewMode})
}

/**
 * Drop entries from the top of one of a panel's stacks while the destination is
 * gone, so the next consumer lands on something live.
 *
 * A history entry can die at any moment and for reasons this panel never sees:
 * its page deleted in another pane, deleted remotely and synced in, or swept up
 * as a DESCENDANT of some deleted ancestor. No delete-time purge can enumerate
 * those — by the time anything hears about a subtree delete the subtree is
 * already tombstoned and can't be walked to collect its ids. So the stacks are
 * validated at CONSUMPTION time instead: whatever went stale surfaces at the
 * top eventually and is dropped there, whatever killed it.
 *
 * Lazy on purpose — only the leading run of dead entries is checked, never the
 * whole stack. `alsoDeadId` treats an id as dead regardless of what the row
 * says, for the recovery path where the caller already knows the page is gone.
 */
const pruneDeadTop = async (
  panelBlock: Block,
  side: 'back' | 'forward',
  alsoDeadId?: string,
): Promise<void> => {
  for (;;) {
    const top = panelHistory.peek(panelBlock.id, side)
    if (!top) return
    // TOMBSTONED, not merely absent. `repo.exists` answers false for both, and
    // dropping on that lost a valid entry for good: follow a shared link whose
    // row hasn't replicated yet, navigate on, press Back before it arrives, and
    // the only in-app route to that page was gone — even though the row showed
    // up moments later. Same rule the recovery watchdog follows; an unsynced
    // destination is worth landing on blank, a deleted one is not.
    if (top.blockId !== alsoDeadId && !await isBlockTombstoned(panelBlock.repo, top.blockId)) return
    // Compare-and-swap on the entry we just inspected: a navigation during the
    // await above pushes a NEW entry onto this same stack, and a blind drop
    // would discard THAT instead of the dead one — losing the user's way back
    // to the page they just left. If the top moved, stop pruning; the caller's
    // own stale-press guard handles the rest.
    if (!panelHistory.dropTop(panelBlock.id, side, top)) return
  }
}

/** Step the panel one entry back. Captures the current visit's state onto
 *  forward, then restores the destination's snapshot (focused block, scroll).
 *  Dead entries at the top of the stack are dropped first, so Back never lands
 *  the pane on a tombstone; if that empties the stack, this is a no-op. */
export const goBackInPanel = async (panelBlock: Block): Promise<boolean> => {
  const current = panelBlock.peekProperty(topLevelBlockIdProp)
  if (!current) return false
  await pruneDeadTop(panelBlock, 'back')
  // The prune awaits row loads. If the pane navigated in the meantime this
  // chevron press is stale: consuming the stack now would pull the pane off the
  // user's new destination and park the wrong page on Forward.
  if (panelBlock.peekProperty(topLevelBlockIdProp) !== current) return false
  const dest = panelHistory.back(panelBlock.id, {
    blockId: current,
    state: panelHistory.snapshot(panelBlock.id),
  })
  if (!dest) return false
  panelHistory.enqueueRestore(panelBlock.id, dest.state)
  // Chevron restore applies the remembered mode (URL-driven restores don't).
  await transactPanelContent(panelBlock, dest.blockId, dest.state, 'panel history back', {viewMode: dest.state?.viewMode})
  return true
}

/** Mirror of `goBackInPanel` for the forward stack — including the dead-entry
 *  prune, which is what keeps Forward off a descendant of a page that was
 *  deleted while it sat on the forward stack (navigate P → C, Back to P, delete
 *  P: C is tombstoned with the rest of P's subtree). */
export const goForwardInPanel = async (panelBlock: Block): Promise<boolean> => {
  const current = panelBlock.peekProperty(topLevelBlockIdProp)
  if (!current) return false
  await pruneDeadTop(panelBlock, 'forward')
  // Same stale-press guard as goBackInPanel.
  if (panelBlock.peekProperty(topLevelBlockIdProp) !== current) return false
  const dest = panelHistory.forward(panelBlock.id, {
    blockId: current,
    state: panelHistory.snapshot(panelBlock.id),
  })
  if (!dest) return false
  panelHistory.enqueueRestore(panelBlock.id, dest.state)
  await transactPanelContent(panelBlock, dest.blockId, dest.state, 'panel history forward', {viewMode: dest.state?.viewMode})
  return true
}

/** Recover a panel that is currently showing a now-deleted block. Steps back
 *  through history to the nearest STILL-LIVE entry — skipping tombstones, which
 *  is what handles a back stack pointing INTO the deleted subtree (its
 *  descendants are all dead) — else falls back to `fallbackId` (the workspace
 *  landing page). The dead current page is never parked on the forward stack
 *  (unlike `goBackInPanel`). Entries that die deeper in either stack aren't
 *  chased here — `pruneDeadTop` catches them when a chevron reaches
 *  them. A no-op when no live destination exists — leaves the pane as-is rather
 *  than closing it. Each pane runs its own recovery, so a page open in several
 *  panes is retargeted in all of them. */
export const recoverPanelOffDeadContent = async (
  panelBlock: Block,
  deadBlockId: string,
  /** Terminal fallback, resolved LAZILY — only when history yields nothing
   *  live. Landing resolvers are get-or-create (they may write), so a pane
   *  that recovers via history must not pay for one. */
  resolveFallback: () => Promise<string | null>,
): Promise<void> => {
  const repo = panelBlock.repo
  /** Is this recovery still the right thing to do? Every step below awaits, and
   *  in that time the user can navigate the pane, close it, or undo the delete —
   *  after which recovering would yank the pane off wherever they actually are.
   *  Re-checked before anything is consumed AND again immediately before the
   *  write, since the gap between them is where the loads happen. */
  const stillStranded = () =>
    panelBlock.peekProperty(topLevelBlockIdProp) === deadBlockId
    && !repo.block(deadBlockId).peek()
  if (!stillStranded()) return

  await pruneDeadTop(panelBlock, 'back', deadBlockId)
  const dest = panelHistory.peek(panelBlock.id, 'back')
  let targetId = dest?.blockId ?? null
  if (!targetId) {
    const fallbackId = await resolveFallback()
    // `!== deadBlockId` is belt-and-braces — a resolver is contracted to
    // decline the excluded id (`WorkspaceLandingContext.excludeBlockId`) — but
    // landing here would strand the pane right back on the tombstone.
    if (fallbackId && fallbackId !== deadBlockId && (await repo.exists(fallbackId))) {
      targetId = fallbackId
    }
  }
  if (!stillStranded()) return
  if (!targetId) return
  // Record the confirmed delete before the write. By now the cached tombstone
  // the projection would otherwise read is gone — the hook's ensure-load
  // markMissing's it — so this set is the only thing that can still tell the
  // projection this page was DELETED rather than merely absent, which is what
  // keeps browser Back off it. Never retracted; see the set's docblock.
  markBlockConfirmedDeleted(deadBlockId)
  panelHistory.enqueueRestore(panelBlock.id, dest?.state)
  try {
    await transactPanelContent(
      panelBlock, targetId, dest?.state, 'recover panel off deleted content',
      {viewMode: dest?.state?.viewMode},
    )
  } catch (error) {
    // The write failed, so the pane is still ON the dead block. Drain the
    // restore queued in anticipation of a move that didn't happen.
    panelHistory.consumeRestore(panelBlock.id)
    console.error('[panel-history] recovery write failed; pane left on the dead block', error)
    return
  }
  // Consume the destination only once the pane is actually on it, so a failed
  // write costs the user nothing. Compare-and-swap because the write awaited: if
  // something pushed in the meantime, that new entry is the user's way back to
  // where they now are and must not be discarded in its place.
  //
  // Not airtight, and can't be made so from here: a navigation landing in this
  // window pushes the pane's CURRENT block, which is `dest.blockId` — and
  // `push` DEDUPES against an identical top rather than stacking, so the top is
  // still `dest`, the swap matches, and the drop removes an entry the
  // navigation meant to keep. Reaching it needs a programmatic navigation
  // inside the gap between the commit and this line (one macrotask), not a
  // human one, and the cost is one skipped Back step.
  if (dest) panelHistory.dropTop(panelBlock.id, 'back', dest)
  // Deliberately NOT purging the dead id from the stacks here. Entries are
  // validated at CONSUMPTION time (`pruneDeadTop`), which already covers
  // anything this could purge — and purging made undo a one-way door: restore
  // the page and neither chevron could reach it again, because the entries
  // pointing at it were gone.
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
