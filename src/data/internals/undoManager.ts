/**
 * Undo / redo manager (spec §10 step 7, §17 line 2228).
 *
 * Per-scope undo + redo stacks. Every committed `repo.tx` whose scope
 * is undoable (`BlockDefault`, `References`) gets one entry on its
 * scope's undo stack — the entry holds the tx's snapshots map, which
 * already captures `(before, after)` per touched id. Replay walks the
 * map and uses `TxImpl.applyRaw` to drive each row to either `before`
 * (undo direction) or `after` (redo direction). Replays themselves
 * are not recorded on the undo stack — they push the SAME entry across
 * stacks (manager-managed), so the cycle is symmetric and idempotent
 * across repeated undo/redo presses.
 *
 * What this is NOT:
 *   - Checkpoint coalescing for fine-grained typing (§16.4 — deferred).
 *     v1 granularity is one entry per `repo.tx`; CodeMirror's internal
 *     undo handles per-keystroke during edit-mode, and the document
 *     write happens once on save/blur — already coarse-grained.
 *   - Events-derived undo (§16.6 — deferred). row_events.before_json
 *     enables a future drift-tolerant variant; for now snapshots are
 *     in-memory only.
 *
 * Scope semantics:
 *   - `BlockDefault` — user undo stack (the cmd-Z target).
 *   - `References` — separate bucket; recorded for parity with the spec
 *     but not exposed to user undo (§7.3, §5.8). `repo.undo` defaults
 *     to `BlockDefault`.
 *   - `UserPrefs` — never recorded. Preference writes sync, but cmd-Z
 *     should not toggle recents / app settings.
 *   - `UiState` — never recorded (selection / focus state isn't
 *     undoable). The `record` call no-ops on this scope.
 */

import { ChangeScope, scopeIsUndoable } from '@/data/api'
import { CallbackSet } from '@/utils/callbackSet'
import type { SnapshotsMap } from './txSnapshots'

export interface UndoEntry {
  scope: ChangeScope
  /** Workspace this tx was pinned to. Undo / redo are scoped to the
   *  active workspace through this field, so cmd-Z only ever acts on the
   *  workspace the user is actually looking at and never reverts — or
   *  re-uploads — an edit in a workspace they've switched away from
   *  (issue #186). Captured from the committed tx's pinned workspace. */
  workspaceId: string
  txId: string
  snapshots: SnapshotsMap
  description?: string
}

export interface UndoManagerOptions {
  /** Cap per-scope stack depth. Older entries fall off. Default 100;
   *  matches typical editor undo bounds. */
  maxDepth?: number
}

export class UndoManager {
  private readonly undoStacks: Map<ChangeScope, UndoEntry[]> = new Map()
  private readonly redoStacks: Map<ChangeScope, UndoEntry[]> = new Map()
  private readonly listenersByScope: Map<ChangeScope, CallbackSet<[]>> = new Map()
  private readonly maxDepth: number

  constructor(opts: UndoManagerOptions = {}) {
    this.maxDepth = opts.maxDepth ?? 100
  }

  /** Push an entry onto the undo stack of its scope. Side-effects:
   *  clears the redo branch for the entry's *workspace* (a new action
   *  invalidates that workspace's redo future, but must not wipe another
   *  workspace's history — issue #186). No-op for non-undoable scopes
   *  and zero-write txs.
   *
   *  Subscriber-visible state must be consistent at notify-time, so the
   *  redo clear happens BEFORE pushUndo's notify fires — otherwise a
   *  listener that recomputes `depths()` would see the stale pre-clear
   *  redo count and keep redo UI enabled. */
  record(entry: UndoEntry): void {
    if (!this.isUndoable(entry.scope)) return
    if (entry.snapshots.size === 0) return
    this.clearRedoForWorkspace(entry.scope, entry.workspaceId)
    this.pushUndo(entry.scope, entry)
  }

  peekUndo(scope: ChangeScope): UndoEntry | null {
    return this.getUndo(scope).at(-1) ?? null
  }

  peekRedo(scope: ChangeScope): UndoEntry | null {
    return this.getRedo(scope).at(-1) ?? null
  }

  /** Most recent undo entry for `workspaceId` (the cmd-Z target while
   *  that workspace is active). Skips entries from other workspaces. */
  peekUndoForWorkspace(scope: ChangeScope, workspaceId: string): UndoEntry | null {
    return this.lastMatching(this.getUndo(scope), workspaceId)
  }

  peekRedoForWorkspace(scope: ChangeScope, workspaceId: string): UndoEntry | null {
    return this.lastMatching(this.getRedo(scope), workspaceId)
  }

  popUndo(scope: ChangeScope): UndoEntry | null {
    const entry = this.getUndo(scope).pop() ?? null
    if (entry !== null) this.notify(scope)
    return entry
  }

  popRedo(scope: ChangeScope): UndoEntry | null {
    const entry = this.getRedo(scope).pop() ?? null
    if (entry !== null) this.notify(scope)
    return entry
  }

  /** Pop the most recent entry for `workspaceId` off `scope`'s undo
   *  stack, leaving entries from other workspaces in place. This is the
   *  workspace-scoped cmd-Z primitive: undo only ever acts on the active
   *  workspace's most recent entry, never an edit in a workspace the user
   *  has since switched away from (issue #186). */
  popUndoForWorkspace(scope: ChangeScope, workspaceId: string): UndoEntry | null {
    return this.popMatching(this.getUndo(scope), scope, workspaceId)
  }

  popRedoForWorkspace(scope: ChangeScope, workspaceId: string): UndoEntry | null {
    return this.popMatching(this.getRedo(scope), scope, workspaceId)
  }

  pushUndo(scope: ChangeScope, entry: UndoEntry): void {
    const stack = this.getUndo(scope)
    stack.push(entry)
    if (stack.length > this.maxDepth) stack.shift()
    this.notify(scope)
  }

  pushRedo(scope: ChangeScope, entry: UndoEntry): void {
    const stack = this.getRedo(scope)
    stack.push(entry)
    if (stack.length > this.maxDepth) stack.shift()
    this.notify(scope)
  }

  /** Subscribe to stack-shape changes for `scope`. Fires after any
   *  record / push / pop on either the undo or redo stack of that
   *  scope. Used by reactive UI (toast button enable-state, future
   *  Edit-menu Undo/Redo) to re-read `peekUndo` / `depths`. Returns
   *  an unsubscribe; listener exceptions are isolated by CallbackSet. */
  subscribe(scope: ChangeScope, listener: () => void): () => void {
    return this.listenersFor(scope).add(listener)
  }

  /** Drop all stacks (for tests + an eventual "clear history" UX).
   *  Notifies subscribers on every scope that previously had state. */
  clear(): void {
    const touched = new Set<ChangeScope>([
      ...this.undoStacks.keys(),
      ...this.redoStacks.keys(),
    ])
    this.undoStacks.clear()
    this.redoStacks.clear()
    for (const scope of touched) this.notify(scope)
  }

  /** Stack depths — used by UI to enable / disable undo/redo buttons. */
  depths(scope: ChangeScope): { undo: number; redo: number } {
    return {
      undo: this.getUndo(scope).length,
      redo: this.getRedo(scope).length,
    }
  }

  /** Only document/reference scopes are undoable. */
  private isUndoable(scope: ChangeScope): boolean {
    return scopeIsUndoable(scope)
  }

  /** Last entry in `stack` belonging to `workspaceId`, or null. */
  private lastMatching(stack: UndoEntry[], workspaceId: string): UndoEntry | null {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].workspaceId === workspaceId) return stack[i]
    }
    return null
  }

  /** Remove + return the last entry in `stack` belonging to
   *  `workspaceId`, notifying on `scope` if one was removed. Splicing
   *  from the middle keeps the relative order of the remaining (and the
   *  removed workspace's older) entries, so the undo↔redo shuttle stays
   *  symmetric within each workspace. */
  private popMatching(
    stack: UndoEntry[],
    scope: ChangeScope,
    workspaceId: string,
  ): UndoEntry | null {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].workspaceId === workspaceId) {
        const [entry] = stack.splice(i, 1)
        this.notify(scope)
        return entry
      }
    }
    return null
  }

  /** Drop only `workspaceId`'s redo branch on `scope`. A new edit in one
   *  workspace invalidates that workspace's redo future but must leave
   *  every other workspace's history intact (issue #186). */
  private clearRedoForWorkspace(scope: ChangeScope, workspaceId: string): void {
    const redo = this.getRedo(scope)
    const kept = redo.filter((e) => e.workspaceId !== workspaceId)
    if (kept.length !== redo.length) {
      redo.length = 0
      redo.push(...kept)
    }
  }

  private getUndo(scope: ChangeScope): UndoEntry[] {
    let stack = this.undoStacks.get(scope)
    if (!stack) {
      stack = []
      this.undoStacks.set(scope, stack)
    }
    return stack
  }

  private getRedo(scope: ChangeScope): UndoEntry[] {
    let stack = this.redoStacks.get(scope)
    if (!stack) {
      stack = []
      this.redoStacks.set(scope, stack)
    }
    return stack
  }

  private listenersFor(scope: ChangeScope): CallbackSet<[]> {
    let set = this.listenersByScope.get(scope)
    if (!set) {
      set = new CallbackSet(`UndoManager[${scope}]`)
      this.listenersByScope.set(scope, set)
    }
    return set
  }

  private notify(scope: ChangeScope): void {
    this.listenersByScope.get(scope)?.notify()
  }
}
