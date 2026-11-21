// @vitest-environment node
/**
 * The one definition of "is the row at this derived id mine?".
 *
 * Every get-or-create over a derived id used to answer this itself, and each
 * copy carried a different subset of the clauses — which is how the same bug
 * got fixed three times over (a kernel page repaired in another workspace, a
 * tombstone tagged, another workspace's row tagged). Consolidating only helps
 * if the shared definition is pinned harder than any single copy was, so the
 * whole verdict table is exercised here rather than through whichever caller
 * happens to reach a branch.
 *
 * The PRECEDENCE cases are the ones worth having. Each caller re-derives its
 * behaviour from the order of these clauses — `getOrCreateKernelPage`'s restore
 * branch is safe from foreign rows only because `foreign` outranks
 * `tombstoned`, not because it checks twice — so a reordering that keeps every
 * individual clause intact is still a live data bug.
 */

import { describe, expect, it, vi } from 'vitest'

import type { BlockData } from './api'
import { classifyOccupant } from './derivedIds'

const WS = 'ws-mine'
const OTHER_WS = 'ws-theirs'

const block = (overrides: Partial<BlockData> = {}): BlockData => ({
  id: 'block-1',
  workspaceId: WS,
  parentId: null,
  orderKey: 'a0',
  content: '',
  properties: {},
  references: [],
  createdAt: 0,
  updatedAt: 0,
  userUpdatedAt: 0,
  createdBy: 'user-1',
  updatedBy: 'user-1',
  deleted: false,
  ...overrides,
})

describe('classifyOccupant', () => {
  it('reports an empty id as absent, with no block to hand back', () => {
    expect(classifyOccupant(null, {workspaceId: WS})).toEqual({verdict: 'absent', block: null})
  })

  it('accepts a live row in this workspace when nothing objects', () => {
    const occupant = block()
    expect(classifyOccupant(occupant, {workspaceId: WS}))
      .toEqual({verdict: 'ours', block: occupant})
  })

  it('reports a row in another workspace as foreign', () => {
    expect(classifyOccupant(block({workspaceId: OTHER_WS}), {workspaceId: WS}).verdict)
      .toBe('foreign')
  })

  it('reports a soft-deleted row in this workspace as tombstoned', () => {
    expect(classifyOccupant(block({deleted: true}), {workspaceId: WS}).verdict)
      .toBe('tombstoned')
  })

  it('reports a live row the caller declines as rejected', () => {
    expect(classifyOccupant(block(), {workspaceId: WS, adoptable: () => false}).verdict)
      .toBe('rejected')
  })

  /**
   * Order, not just membership. Both cases below would still return a
   * not-`ours` verdict with the clauses reordered — what changes is WHICH, and
   * every caller branches on that.
   */
  describe('precedence', () => {
    it('calls a foreign tombstone foreign, so a restore policy never sees it', () => {
      // `getOrCreateKernelPage` and `getOrCreateDailyNote` both restore on
      // `tombstoned`. Ranking `deleted` first would hand them another
      // workspace's tombstone as something to resurrect, under this
      // workspace's alias — with no second check anywhere to stop it.
      expect(classifyOccupant(
        block({workspaceId: OTHER_WS, deleted: true}), {workspaceId: WS},
      ).verdict).toBe('foreign')
    })

    it('never asks the caller about a row that is not live and not ours', () => {
      // `adoptable` is written against live records of the caller's own kind
      // ("is this workout still open?"). Asked about a tombstone or someone
      // else's row it will happily answer yes, and the `ours` that follows is
      // a write into a block the caller was never entitled to touch.
      const adoptable = vi.fn(() => true)

      expect(classifyOccupant(block({deleted: true}), {workspaceId: WS, adoptable}).verdict)
        .toBe('tombstoned')
      expect(classifyOccupant(block({workspaceId: OTHER_WS}), {workspaceId: WS, adoptable}).verdict)
        .toBe('foreign')

      expect(adoptable).not.toHaveBeenCalled()
    })
  })
})
