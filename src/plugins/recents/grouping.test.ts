import { describe, expect, it } from 'vitest'
import type { BlockData } from '@/data/api'
import { typesProp } from '@/data/properties'
import { PAGE_TYPE } from '@/data/blockTypes'
import { DEFAULT_SESSION_GAP_MS, groupRecentActivity } from './grouping'

const MINUTE = 60 * 1000
const T0 = 1_700_000_000_000

interface Spec {
  id: string
  /** Minutes before T0. */
  ago?: number
  parentId?: string
  page?: boolean
}

/** Build a tiny block world: `specs` in creation order, with edit times
 *  derived from `ago`. Returns the pieces `groupRecentActivity` takes —
 *  rows newest-first, and each row's leaf-to-root chain (self excluded),
 *  which is exactly the shape `core.manyAncestors` returns. */
const world = (specs: readonly Spec[]) => {
  const byId = new Map<string, {spec: Spec; data: BlockData}>()
  for (const spec of specs) {
    const properties: Record<string, unknown> = {}
    if (spec.page) properties[typesProp.name] = typesProp.codec.encode([PAGE_TYPE])
    byId.set(spec.id, {
      spec,
      data: {
        id: spec.id,
        workspaceId: 'ws',
        parentId: spec.parentId ?? null,
        orderKey: 'a0',
        content: spec.id,
        properties,
        references: [],
        createdAt: T0,
        updatedAt: T0 - (spec.ago ?? 0) * MINUTE,
        userUpdatedAt: T0 - (spec.ago ?? 0) * MINUTE,
        createdBy: 'u',
        updatedBy: 'u',
        deleted: false,
      } as BlockData,
    })
  }

  const chain = (id: string): BlockData[] => {
    const out: BlockData[] = []
    let cursor = byId.get(id)?.spec.parentId ?? null
    while (cursor) {
      const next = byId.get(cursor)
      if (!next) break
      out.push(next.data)
      cursor = next.spec.parentId ?? null
    }
    return out
  }

  // Rows are the edited set (everything with an `ago`), newest first —
  // structural-only nodes (a page nobody touched) stay out of `rows` but
  // still appear in the chains, same as the real queries.
  const rows = specs
    .filter(s => s.ago !== undefined)
    .map(s => byId.get(s.id)!.data)
    .sort((a, b) => b.userUpdatedAt! - a.userUpdatedAt!)
  const ancestorsById = new Map(rows.map(r => [r.id, chain(r.id)] as const))
  return {rows, ancestorsById}
}

describe('groupRecentActivity', () => {
  it('folds an imported tree into its root, at any depth', () => {
    // The shape an ingest writes: root + descendants, same second.
    const {rows, ancestorsById} = world([
      {id: 'page', page: true},
      {id: 'thread', parentId: 'page', ago: 1},
      {id: 'msg-1', parentId: 'thread', ago: 1},
      {id: 'msg-2', parentId: 'thread', ago: 1},
      {id: 'reply', parentId: 'msg-2', ago: 1},
    ])

    const groups = groupRecentActivity(rows, ancestorsById)

    expect(groups).toHaveLength(1)
    expect(groups[0]!.anchorId).toBe('thread')
    expect(groups[0]!.anchorEdited).toBe(true)
    expect([...groups[0]!.memberIds].sort()).toEqual(['msg-1', 'msg-2', 'reply'])
  })

  it('groups scattered edits under the page they happened on', () => {
    const {rows, ancestorsById} = world([
      {id: 'page', page: true},
      {id: 'a', parentId: 'page', ago: 1},
      {id: 'b', parentId: 'page', ago: 5},
      {id: 'c', parentId: 'page', ago: 9},
    ])

    const groups = groupRecentActivity(rows, ancestorsById)

    expect(groups).toHaveLength(1)
    expect(groups[0]!.anchorId).toBe('page')
    expect(groups[0]!.anchorEdited).toBe(false)
    expect(groups[0]!.memberIds).toEqual(['a', 'b', 'c'])
  })

  it('splits one page into separate entries per session', () => {
    const {rows, ancestorsById} = world([
      {id: 'page', page: true},
      {id: 'morning-1', parentId: 'page', ago: 600},
      {id: 'morning-2', parentId: 'page', ago: 610},
      {id: 'now', parentId: 'page', ago: 1},
    ])

    const groups = groupRecentActivity(rows, ancestorsById)

    expect(groups.map(g => g.anchorId)).toEqual(['page', 'page'])
    expect(groups[0]!.memberIds).toEqual(['now'])
    expect(groups[1]!.memberIds).toEqual(['morning-1', 'morning-2'])
  })

  it('does not fold into an ancestor edited in a different session', () => {
    const {rows, ancestorsById} = world([
      {id: 'page', page: true},
      {id: 'parent', parentId: 'page', ago: 600},
      {id: 'child', parentId: 'parent', ago: 1},
    ])

    const groups = groupRecentActivity(rows, ancestorsById)

    // Separate sessions, so separate entries — both under the page.
    expect(groups).toHaveLength(2)
    expect(groups.map(g => g.memberIds)).toEqual([['child'], ['parent']])
  })

  it('titles the entry by the page when the page itself was edited', () => {
    const {rows, ancestorsById} = world([
      {id: 'page', page: true, ago: 3},
      {id: 'a', parentId: 'page', ago: 1},
    ])

    const groups = groupRecentActivity(rows, ancestorsById)

    expect(groups).toHaveLength(1)
    expect(groups[0]!.anchorId).toBe('page')
    expect(groups[0]!.anchorEdited).toBe(true)
    expect(groups[0]!.memberIds).toEqual(['a'])
    // Stamped by the newest edit in the entry, not by the page's own.
    expect(groups[0]!.lastEditedAt).toBe(T0 - MINUTE)
  })

  it('stamps an old session by its own newest edit, not by a newer edit of its page', () => {
    const {rows, ancestorsById} = world([
      {id: 'page', page: true, ago: 1},
      {id: 'yesterday', parentId: 'page', ago: 1500},
      {id: 'other-page', page: true},
      {id: 'between', parentId: 'other-page', ago: 100},
    ])

    const groups = groupRecentActivity(rows, ancestorsById)

    // The page's own edit is a minute old, `yesterday`'s session is not —
    // it must sort below the unrelated edit that happened in between.
    expect(groups.map(g => g.anchorId)).toEqual(['page', 'other-page', 'page'])
    expect(groups[2]!.memberIds).toEqual(['yesterday'])
    expect(groups[2]!.lastEditedAt).toBe(T0 - 1500 * MINUTE)
  })

  it('keeps a folded tree out of the page entry beside it', () => {
    const {rows, ancestorsById} = world([
      {id: 'page', page: true},
      {id: 'thread', parentId: 'page', ago: 2},
      {id: 'msg', parentId: 'thread', ago: 2},
      {id: 'note-a', parentId: 'page', ago: 1},
      {id: 'note-b', parentId: 'page', ago: 3},
    ])

    const groups = groupRecentActivity(rows, ancestorsById)

    expect(groups.map(g => [g.anchorId, [...g.memberIds]])).toEqual([
      ['page', ['note-a', 'note-b']],
      ['thread', ['msg']],
    ])
  })

  it('keeps edits on different pages apart', () => {
    const {rows, ancestorsById} = world([
      {id: 'page-1', page: true},
      {id: 'page-2', page: true},
      {id: 'a', parentId: 'page-1', ago: 1},
      {id: 'b', parentId: 'page-2', ago: 2},
    ])

    const groups = groupRecentActivity(rows, ancestorsById)

    expect(groups.map(g => g.anchorId)).toEqual(['page-1', 'page-2'])
  })

  it('leaves a pageless block as its own entry', () => {
    const {rows, ancestorsById} = world([
      {id: 'orphan', ago: 1},
    ])

    const groups = groupRecentActivity(rows, ancestorsById)

    expect(groups).toEqual([
      {anchorId: 'orphan', anchorEdited: true, memberIds: [], lastEditedAt: T0 - MINUTE},
    ])
  })

  it('orders entries newest-first and members within an entry too', () => {
    const {rows, ancestorsById} = world([
      {id: 'page-1', page: true},
      {id: 'page-2', page: true},
      {id: 'older', parentId: 'page-1', ago: 20},
      {id: 'newest', parentId: 'page-2', ago: 1},
      {id: 'middle', parentId: 'page-1', ago: 4},
    ])

    const groups = groupRecentActivity(rows, ancestorsById)

    expect(groups.map(g => g.anchorId)).toEqual(['page-2', 'page-1'])
    expect(groups[1]!.memberIds).toEqual(['middle', 'older'])
  })

  it('takes the session window from options', () => {
    const {rows, ancestorsById} = world([
      {id: 'page', page: true},
      {id: 'a', parentId: 'page', ago: 1},
      {id: 'b', parentId: 'page', ago: 20},
    ])

    expect(groupRecentActivity(rows, ancestorsById)).toHaveLength(1)
    expect(groupRecentActivity(rows, ancestorsById, {sessionGapMs: 5 * MINUTE})).toHaveLength(2)
    expect(DEFAULT_SESSION_GAP_MS).toBeGreaterThan(20 * MINUTE)
  })
})
