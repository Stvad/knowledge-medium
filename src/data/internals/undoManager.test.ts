// @vitest-environment node
/**
 * UndoManager unit tests (pure data — no DB harness). Pins the
 * stack-management contract:
 *   - `record` pushes onto the scope's undo stack and clears redo
 *   - UiState/UserPrefs entries are silently dropped
 *   - References + BlockDefault stacks are independent
 *   - Zero-write txs are not recorded (nothing to undo)
 *   - `pushRedo` after popUndo, then `pushUndo` after popRedo — the
 *     same entry shuttles symmetrically across stacks (replay manager
 *     contract)
 *   - maxDepth caps stack length; oldest entries fall off
 *   - Stacks cleared via `clear()`
 *
 * The replay-against-DB tests live in `repoUndo.test.ts` — they need
 * the real `Repo` + PowerSync harness because they exercise SQL state.
 */

import { describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { UndoManager } from './undoManager'
import { newSnapshotsMap } from './txSnapshots'
import { makeBlockData } from '@/data/test/factories'

const A = makeBlockData({id: 'a', workspaceId: 'ws-1', content: 'A'})
const B = makeBlockData({id: 'b', workspaceId: 'ws-1', content: 'B'})

const entry = (
  txId: string,
  scope: ChangeScope,
  ids: string[] = ['a'],
  workspaceId = 'ws-1',
) => {
  const snapshots = newSnapshotsMap()
  for (const id of ids) snapshots.set(id, {before: null, after: A})
  return {txId, scope, workspaceId, snapshots, description: `tx ${txId}`}
}

describe('UndoManager.record', () => {
  it('pushes onto the scope-specific undo stack', () => {
    const m = new UndoManager()
    m.record(entry('t1', ChangeScope.BlockDefault))
    expect(m.peekUndo(ChangeScope.BlockDefault)?.txId).toBe('t1')
    expect(m.peekUndo(ChangeScope.References)).toBeNull()
  })

  it('clears the same-scope redo stack on a new record', () => {
    const m = new UndoManager()
    m.record(entry('t1', ChangeScope.BlockDefault))
    m.pushRedo(ChangeScope.BlockDefault, entry('redo-1', ChangeScope.BlockDefault))
    expect(m.peekRedo(ChangeScope.BlockDefault)?.txId).toBe('redo-1')

    m.record(entry('t2', ChangeScope.BlockDefault))
    expect(m.peekRedo(ChangeScope.BlockDefault)).toBeNull()
  })

  it('does not clear redo on cross-scope record', () => {
    const m = new UndoManager()
    m.pushRedo(ChangeScope.BlockDefault, entry('keep', ChangeScope.BlockDefault))
    m.record(entry('refs', ChangeScope.References))
    expect(m.peekRedo(ChangeScope.BlockDefault)?.txId).toBe('keep')
  })

  it('drops UiState and UserPrefs entries silently', () => {
    const m = new UndoManager()
    m.record(entry('ui', ChangeScope.UiState))
    m.record(entry('prefs', ChangeScope.UserPrefs))
    expect(m.peekUndo(ChangeScope.UiState)).toBeNull()
    expect(m.depths(ChangeScope.UiState)).toEqual({undo: 0, redo: 0})
    expect(m.peekUndo(ChangeScope.UserPrefs)).toBeNull()
    expect(m.depths(ChangeScope.UserPrefs)).toEqual({undo: 0, redo: 0})
  })

  it('drops zero-write entries', () => {
    const m = new UndoManager()
    m.record({
      txId: 'noop',
      scope: ChangeScope.BlockDefault,
      workspaceId: 'ws-1',
      snapshots: newSnapshotsMap(),
    })
    expect(m.peekUndo(ChangeScope.BlockDefault)).toBeNull()
  })

  it('keeps References and BlockDefault stacks independent', () => {
    const m = new UndoManager()
    m.record(entry('default-1', ChangeScope.BlockDefault))
    m.record(entry('refs-1', ChangeScope.References))
    expect(m.peekUndo(ChangeScope.BlockDefault)?.txId).toBe('default-1')
    expect(m.peekUndo(ChangeScope.References)?.txId).toBe('refs-1')
  })
})

describe('UndoManager pop / push round trips', () => {
  it('shuttles the same entry across stacks symmetrically', () => {
    const m = new UndoManager()
    const e = entry('t1', ChangeScope.BlockDefault)
    m.record(e)
    expect(m.depths(ChangeScope.BlockDefault)).toEqual({undo: 1, redo: 0})

    // Simulate undo: pop from undo, push to redo
    const popped = m.popUndo(ChangeScope.BlockDefault)
    expect(popped).toBe(e)
    m.pushRedo(ChangeScope.BlockDefault, popped!)
    expect(m.depths(ChangeScope.BlockDefault)).toEqual({undo: 0, redo: 1})

    // Simulate redo: pop from redo, push to undo
    const redone = m.popRedo(ChangeScope.BlockDefault)
    expect(redone).toBe(e)
    m.pushUndo(ChangeScope.BlockDefault, redone!)
    expect(m.depths(ChangeScope.BlockDefault)).toEqual({undo: 1, redo: 0})
  })

  it('returns null when popping an empty stack', () => {
    const m = new UndoManager()
    expect(m.popUndo(ChangeScope.BlockDefault)).toBeNull()
    expect(m.popRedo(ChangeScope.BlockDefault)).toBeNull()
  })
})

describe('UndoManager workspace scoping (#186)', () => {
  it('pops the active workspace\'s most recent entry, skipping other workspaces', () => {
    const m = new UndoManager()
    // Interleaved: edit in A, switch to B + edit, switch back to A.
    m.record(entry('a1', ChangeScope.BlockDefault, ['a'], 'ws-A'))
    m.record(entry('b1', ChangeScope.BlockDefault, ['b'], 'ws-B'))

    // While viewing A, undo targets a1 even though b1 is the global top.
    expect(m.peekUndoForWorkspace(ChangeScope.BlockDefault, 'ws-A')?.txId).toBe('a1')
    expect(m.popUndoForWorkspace(ChangeScope.BlockDefault, 'ws-A')?.txId).toBe('a1')

    // b1 is untouched — switching to B still finds it.
    expect(m.popUndoForWorkspace(ChangeScope.BlockDefault, 'ws-B')?.txId).toBe('b1')
  })

  it('returns null for a workspace with no entries', () => {
    const m = new UndoManager()
    m.record(entry('a1', ChangeScope.BlockDefault, ['a'], 'ws-A'))
    expect(m.popUndoForWorkspace(ChangeScope.BlockDefault, 'ws-B')).toBeNull()
    // The other workspace's entry is left in place.
    expect(m.peekUndoForWorkspace(ChangeScope.BlockDefault, 'ws-A')?.txId).toBe('a1')
  })

  it('a new edit clears only its own workspace\'s redo branch', () => {
    const m = new UndoManager()
    // Both workspaces have a redo branch (an undone entry).
    m.pushRedo(ChangeScope.BlockDefault, entry('a-redo', ChangeScope.BlockDefault, ['a'], 'ws-A'))
    m.pushRedo(ChangeScope.BlockDefault, entry('b-redo', ChangeScope.BlockDefault, ['b'], 'ws-B'))

    // A new edit in A invalidates A's redo future but must keep B's.
    m.record(entry('a-new', ChangeScope.BlockDefault, ['a'], 'ws-A'))

    expect(m.peekRedoForWorkspace(ChangeScope.BlockDefault, 'ws-A')).toBeNull()
    expect(m.peekRedoForWorkspace(ChangeScope.BlockDefault, 'ws-B')?.txId).toBe('b-redo')
  })
})

describe('UndoManager.maxDepth', () => {
  it('caps the undo stack at maxDepth, oldest falls off', () => {
    const m = new UndoManager({maxDepth: 3})
    m.record(entry('t1', ChangeScope.BlockDefault))
    m.record(entry('t2', ChangeScope.BlockDefault))
    m.record(entry('t3', ChangeScope.BlockDefault))
    m.record(entry('t4', ChangeScope.BlockDefault))
    expect(m.depths(ChangeScope.BlockDefault)).toEqual({undo: 3, redo: 0})
    expect(m.popUndo(ChangeScope.BlockDefault)?.txId).toBe('t4')
    expect(m.popUndo(ChangeScope.BlockDefault)?.txId).toBe('t3')
    expect(m.popUndo(ChangeScope.BlockDefault)?.txId).toBe('t2')
    expect(m.popUndo(ChangeScope.BlockDefault)).toBeNull()
  })
})

describe('UndoManager.subscribe', () => {
  it('fires on record, pop, and push for the matching scope only', () => {
    const m = new UndoManager()
    const blockListener = vi.fn()
    const refsListener = vi.fn()
    m.subscribe(ChangeScope.BlockDefault, blockListener)
    m.subscribe(ChangeScope.References, refsListener)

    m.record(entry('t1', ChangeScope.BlockDefault))
    m.record(entry('r1', ChangeScope.References))
    m.popUndo(ChangeScope.BlockDefault)
    m.pushRedo(ChangeScope.BlockDefault, entry('t1', ChangeScope.BlockDefault))

    expect(blockListener).toHaveBeenCalledTimes(3) // record + pop + pushRedo
    expect(refsListener).toHaveBeenCalledTimes(1)  // refs record only
  })

  it('does not fire on no-op record (non-undoable scope, zero writes)', () => {
    const m = new UndoManager()
    const listener = vi.fn()
    m.subscribe(ChangeScope.UiState, listener)
    m.subscribe(ChangeScope.BlockDefault, listener)

    m.record(entry('ui', ChangeScope.UiState))
    m.record({
      txId: 'noop',
      scope: ChangeScope.BlockDefault,
      workspaceId: 'ws-1',
      snapshots: newSnapshotsMap(),
    })

    expect(listener).not.toHaveBeenCalled()
  })

  it('does not fire on empty-stack pop', () => {
    const m = new UndoManager()
    const listener = vi.fn()
    m.subscribe(ChangeScope.BlockDefault, listener)

    m.popUndo(ChangeScope.BlockDefault)
    m.popRedo(ChangeScope.BlockDefault)

    expect(listener).not.toHaveBeenCalled()
  })

  it('clear fires every scope that previously held state', () => {
    const m = new UndoManager()
    const blockListener = vi.fn()
    const refsListener = vi.fn()
    const idleListener = vi.fn()
    m.subscribe(ChangeScope.BlockDefault, blockListener)
    m.subscribe(ChangeScope.References, refsListener)
    m.subscribe(ChangeScope.UiState, idleListener)
    m.record(entry('t1', ChangeScope.BlockDefault))
    m.record(entry('r1', ChangeScope.References))
    blockListener.mockClear()
    refsListener.mockClear()

    m.clear()

    expect(blockListener).toHaveBeenCalledTimes(1)
    expect(refsListener).toHaveBeenCalledTimes(1)
    expect(idleListener).not.toHaveBeenCalled()
  })

  it('fires record listeners only after redo has been cleared', () => {
    const m = new UndoManager()
    m.pushRedo(ChangeScope.BlockDefault, entry('stale-redo', ChangeScope.BlockDefault))
    const observed: Array<{undo: number; redo: number}> = []
    m.subscribe(ChangeScope.BlockDefault, () => {
      observed.push(m.depths(ChangeScope.BlockDefault))
    })

    m.record(entry('t1', ChangeScope.BlockDefault))

    expect(observed).toEqual([{undo: 1, redo: 0}])
  })

  it('returns an unsubscribe that detaches the listener', () => {
    const m = new UndoManager()
    const listener = vi.fn()
    const off = m.subscribe(ChangeScope.BlockDefault, listener)

    m.record(entry('t1', ChangeScope.BlockDefault))
    off()
    m.record(entry('t2', ChangeScope.BlockDefault))

    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('UndoManager.clear', () => {
  it('drops all stacks across all scopes', () => {
    const m = new UndoManager()
    m.record(entry('t1', ChangeScope.BlockDefault))
    m.record(entry('t2', ChangeScope.References))
    m.pushRedo(ChangeScope.BlockDefault, entry('r1', ChangeScope.BlockDefault))
    m.clear()
    expect(m.depths(ChangeScope.BlockDefault)).toEqual({undo: 0, redo: 0})
    expect(m.depths(ChangeScope.References)).toEqual({undo: 0, redo: 0})
  })
})

void B  // referenced only to keep the factory import lint-clean if expanded later
