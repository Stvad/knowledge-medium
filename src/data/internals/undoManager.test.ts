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

import { describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { UndoManager } from './undoManager'
import { newSnapshotsMap } from './txSnapshots'
import { makeBlockData } from '@/data/test/factories'

const A = makeBlockData({id: 'a', workspaceId: 'ws-1', content: 'A'})
const B = makeBlockData({id: 'b', workspaceId: 'ws-1', content: 'B'})

const entry = (txId: string, scope: ChangeScope, ids: string[] = ['a']) => {
  const snapshots = newSnapshotsMap()
  for (const id of ids) snapshots.set(id, {before: null, after: A})
  return {txId, scope, snapshots, description: `tx ${txId}`}
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
