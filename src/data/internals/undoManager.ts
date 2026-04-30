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
 *   - `UiState` — never recorded (selection / focus state isn't
 *     undoable). The `record` call no-ops on this scope.
 */

import { ChangeScope } from '@/data/api'
import type { SnapshotsMap } from './txSnapshots'

export interface UndoEntry {
  scope: ChangeScope
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
  private readonly maxDepth: number

  constructor(opts: UndoManagerOptions = {}) {
    this.maxDepth = opts.maxDepth ?? 100
  }

  /** Push an entry onto the undo stack of its scope. Side-effects:
   *  clears the redo stack for that scope (a new action invalidates
   *  the redo branch). No-op for `UiState` (not undoable per spec).
   *  No-op for zero-write txs (nothing to undo). */
  record(entry: UndoEntry): void {
    if (!this.isUndoable(entry.scope)) return
    if (entry.snapshots.size === 0) return
    this.pushUndo(entry.scope, entry)
    this.getRedo(entry.scope).length = 0
  }

  peekUndo(scope: ChangeScope): UndoEntry | null {
    return this.getUndo(scope).at(-1) ?? null
  }

  peekRedo(scope: ChangeScope): UndoEntry | null {
    return this.getRedo(scope).at(-1) ?? null
  }

  popUndo(scope: ChangeScope): UndoEntry | null {
    return this.getUndo(scope).pop() ?? null
  }

  popRedo(scope: ChangeScope): UndoEntry | null {
    return this.getRedo(scope).pop() ?? null
  }

  pushUndo(scope: ChangeScope, entry: UndoEntry): void {
    const stack = this.getUndo(scope)
    stack.push(entry)
    if (stack.length > this.maxDepth) stack.shift()
  }

  pushRedo(scope: ChangeScope, entry: UndoEntry): void {
    const stack = this.getRedo(scope)
    stack.push(entry)
    if (stack.length > this.maxDepth) stack.shift()
  }

  /** Drop all stacks (for tests + an eventual "clear history" UX). */
  clear(): void {
    this.undoStacks.clear()
    this.redoStacks.clear()
  }

  /** Stack depths — used by UI to enable / disable undo/redo buttons. */
  depths(scope: ChangeScope): { undo: number; redo: number } {
    return {
      undo: this.getUndo(scope).length,
      redo: this.getRedo(scope).length,
    }
  }

  /** UiState is not undoable. BlockDefault + References are. */
  private isUndoable(scope: ChangeScope): boolean {
    return scope !== ChangeScope.UiState
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
}
