// @vitest-environment node
/**
 * Unit tests for `replayApplicationOrder` — the end-to-end replay
 * behavior (undo/redo through triggers) is covered in
 * `src/data/test/repoUndo.test.ts`; this file pins the pure ordering
 * function's own contract, including the pathological shapes the
 * integration harness can't build cheaply.
 */
import { describe, expect, it } from 'vitest'
import type { BlockData } from '@/data/api'
import { newSnapshotsMap, recordWrite, replayApplicationOrder } from './txSnapshots.ts'

const block = (id: string, parentId: string | null, deleted = false): BlockData => ({
  id,
  workspaceId: 'ws',
  parentId,
  orderKey: 'a0',
  content: '',
  properties: {},
  references: [],
  createdAt: 0,
  updatedAt: 0,
  userUpdatedAt: 0,
  createdBy: 'u',
  updatedBy: 'u',
  deleted,
})

describe('replayApplicationOrder', () => {
  it('orders live targets parents-first regardless of insertion order', () => {
    const snapshots = newSnapshotsMap()
    // Child recorded before its parent — first-touch order must not win.
    recordWrite(snapshots, 'child', null, block('child', 'parent'))
    recordWrite(snapshots, 'grandchild', null, block('grandchild', 'child'))
    recordWrite(snapshots, 'parent', null, block('parent', null))

    const ordered = replayApplicationOrder(snapshots, 'after').map(([id]) => id)
    expect(ordered.indexOf('parent')).toBeLessThan(ordered.indexOf('child'))
    expect(ordered.indexOf('child')).toBeLessThan(ordered.indexOf('grandchild'))
  })

  it('handles an arbitrarily deep chain without overflowing the stack', () => {
    // Regression (Codex review on PR #371): the depth walk recursed one
    // frame per parent hop, so undoing a delete of a very deep subtree
    // (one entry, one long chain) hit RangeError. 200k hops overflows
    // any recursive implementation; the iterative walk must not care.
    const DEPTH = 200_000
    const snapshots = newSnapshotsMap()
    // Insert leaf-first so memoization can't accidentally save the day.
    for (let i = DEPTH - 1; i >= 0; i--) {
      recordWrite(snapshots, `n${i}`, null, block(`n${i}`, i === 0 ? null : `n${i - 1}`))
    }
    const ordered = replayApplicationOrder(snapshots, 'after')
    expect(ordered).toHaveLength(DEPTH)
    expect(ordered[0][0]).toBe('n0')
    expect(ordered[DEPTH - 1][0]).toBe(`n${DEPTH - 1}`)
  })

  it('degrades gracefully on a malformed cyclic target graph', () => {
    const snapshots = newSnapshotsMap()
    recordWrite(snapshots, 'a', null, block('a', 'b'))
    recordWrite(snapshots, 'b', null, block('b', 'a'))
    recordWrite(snapshots, 'c', null, block('c', 'a'))

    // Terminates, includes every id exactly once.
    const ordered = replayApplicationOrder(snapshots, 'after').map(([id]) => id)
    expect([...ordered].sort()).toEqual(['a', 'b', 'c'])
  })

  it('exempts tombstoned and hard-deleted targets from ordering, appended last', () => {
    const snapshots = newSnapshotsMap()
    recordWrite(snapshots, 'gone', block('gone', null), null)
    recordWrite(snapshots, 'tombstone', block('tombstone', null), block('tombstone', null, true))
    recordWrite(snapshots, 'live', null, block('live', null))

    const ordered = replayApplicationOrder(snapshots, 'after')
    expect(ordered[0][0]).toBe('live')
    expect(ordered.slice(1).map(([id]) => id).sort()).toEqual(['gone', 'tombstone'])
  })
})
