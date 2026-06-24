// @vitest-environment node
/**
 * Layout B observer — cycle-scan candidate selection (design doc §4.7).
 *
 * `cycleScanCandidatesByWorkspace` is the pure predicate that decides which
 * just-materialized rows are worth a (bounded, expensive) reachability scan:
 * only a row that *moved parents while staying live* can newly close a loop.
 * The end-to-end SQL scan is covered in observer.test.ts; this pins the
 * selection rules directly so each skip branch is exercised in isolation
 * (the scan is detection-only telemetry, so a wrong predicate fails silent).
 */

import { describe, expect, it } from 'vitest'
import { cycleScanCandidatesByWorkspace } from './observer.js'
import type { SyncSnapshot } from './materialize.js'
import type { BlockData } from '@/data/api'

const block = (o: Partial<BlockData> = {}): BlockData => ({
  id: 'b', workspaceId: 'ws', parentId: null, referenceTargetId: null, orderKey: 'a0', content: '',
  properties: {}, references: [], createdAt: 1, updatedAt: 1, userUpdatedAt: 1, createdBy: 'u',
  updatedBy: 'u', deleted: false, ...o,
})

/** A live row whose parent moved p1 -> p2 in workspace `ws` — the one shape
 *  that qualifies. */
const reparented = (id: string, ws = 'ws'): SyncSnapshot => ({
  before: block({ id, workspaceId: ws, parentId: 'p1' }),
  after: block({ id, workspaceId: ws, parentId: 'p2' }),
})

const run = (entries: Array<[string, SyncSnapshot]>) =>
  cycleScanCandidatesByWorkspace(new Map(entries))

describe('cycleScanCandidatesByWorkspace', () => {
  it('selects a live row that moved parents, keyed by its current workspace', () => {
    const result = run([['x', reparented('x')]])
    expect(Object.fromEntries(result)).toEqual({ ws: ['x'] })
  })

  it('groups multiple reparented rows by their after-workspace', () => {
    const result = run([
      ['a', reparented('a', 'ws-1')],
      ['b', reparented('b', 'ws-2')],
      ['c', reparented('c', 'ws-1')],
    ])
    expect(result.get('ws-1')?.sort()).toEqual(['a', 'c'])
    expect(result.get('ws-2')).toEqual(['b'])
  })

  it('ignores a fresh insert (no before-row can close a loop on its own)', () => {
    const result = run([['x', { before: null, after: block({ parentId: 'p2' }) }]])
    expect(result.size).toBe(0)
  })

  it('ignores a hard-deleted row (no after-row)', () => {
    const result = run([['x', { before: block({ parentId: 'p1' }), after: null }]])
    expect(result.size).toBe(0)
  })

  it('ignores a row that was a tombstone before or became one after', () => {
    const wasTombstone: SyncSnapshot = {
      before: block({ parentId: 'p1', deleted: true }),
      after: block({ parentId: 'p2' }),
    }
    const becameTombstone: SyncSnapshot = {
      before: block({ parentId: 'p1' }),
      after: block({ parentId: 'p2', deleted: true }),
    }
    expect(run([['was', wasTombstone], ['became', becameTombstone]]).size).toBe(0)
  })

  it('ignores a content-only edit (parent unchanged → reachability unchanged)', () => {
    const result = run([['x', {
      before: block({ parentId: 'p1', content: 'v1' }),
      after: block({ parentId: 'p1', content: 'v2' }),
    }]])
    expect(result.size).toBe(0)
  })

  it('ignores a reparent whose after-row has no workspace id', () => {
    const result = run([['x', {
      before: block({ parentId: 'p1', workspaceId: 'ws' }),
      after: block({ parentId: 'p2', workspaceId: '' }),
    }]])
    expect(result.size).toBe(0)
  })

  it('returns an empty map for an empty snapshot set', () => {
    expect(run([]).size).toBe(0)
  })
})
