import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { isCollapsedProp } from '@/data/properties'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import {
  blockAfterSubtreeRemoval,
  blockIdsInOrderedSelectionRange,
  findBestSelectionAnchorIndex,
  getBlocksInRange,
  getLastVisibleDescendant,
  validateSelectionHierarchy,
} from '@/utils/selection.js'

const WS = 'ws-1'
const USER: User = {id: 'user-1'}

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  // Shared DB opened once per file (beforeAll), reset here per test.
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const { repo } = createTestRepo({
    db: sharedDb.db,
    user: USER,
  })
  repo.setActiveWorkspaceId(WS)
  return {h, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  env = await setup()
})

const seedOutline = async (
  repo: Repo,
  rows: Array<{id: string; parentId: string | null; orderKey: string}>,
): Promise<void> => {
  await repo.tx(async tx => {
    for (const row of rows) {
      await tx.create({
        id: row.id,
        workspaceId: WS,
        parentId: row.parentId,
        orderKey: row.orderKey,
        content: row.id,
      })
    }
  }, {scope: ChangeScope.UiState})
}

describe('ordered selection ranges', () => {
  const locations = [
    {blockId: 'A', renderScopeId: 'outline:A'},
    {blockId: 'X', renderScopeId: 'backlink:1:X'},
    {blockId: 'X', renderScopeId: 'backlink:2:X'},
    {blockId: 'B', renderScopeId: 'outline:B'},
  ]

  it('returns unique block ids in rendered range order', () => {
    expect(blockIdsInOrderedSelectionRange(locations, 0, 3)).toEqual(['A', 'X', 'B'])
    expect(blockIdsInOrderedSelectionRange(locations, 3, 1)).toEqual(['X', 'B'])
  })

  it('uses the focused rendered location to disambiguate duplicate anchor blocks', () => {
    expect(findBestSelectionAnchorIndex(locations, {
      anchorBlockId: 'X',
      targetIndex: 3,
      currentLocation: {blockId: 'X', renderScopeId: 'backlink:2:X'},
    })).toBe(2)
  })

  it('falls back to the duplicate anchor that best preserves the current selection', () => {
    const spacedLocations = [
      {blockId: 'A', renderScopeId: 'outline:A'},
      {blockId: 'X', renderScopeId: 'backlink:1:X'},
      {blockId: 'C', renderScopeId: 'outline:C'},
      {blockId: 'X', renderScopeId: 'backlink:2:X'},
      {blockId: 'B', renderScopeId: 'outline:B'},
    ]

    expect(findBestSelectionAnchorIndex(spacedLocations, {
      anchorBlockId: 'X',
      targetIndex: 4,
      selectedBlockIds: ['X', 'B'],
    })).toBe(3)
  })
})

describe('blockAfterSubtreeRemoval', () => {
  it('returns the next data-sibling when one exists', async () => {
    // top > [a, b, c]; remove b → next sibling = c
    await seedOutline(env.repo, [
      {id: 'top', parentId: null, orderKey: 'a'},
      {id: 'a', parentId: 'top', orderKey: 'b'},
      {id: 'b', parentId: 'top', orderKey: 'c'},
      {id: 'c', parentId: 'top', orderKey: 'd'},
    ])
    const result = await blockAfterSubtreeRemoval(env.repo.block('b'), 'top')
    expect(result?.id).toBe('c')
  })

  it("returns the previous sibling when the block is the last of its parent's children", async () => {
    // top > [a, b]; remove b → prev = a
    await seedOutline(env.repo, [
      {id: 'top', parentId: null, orderKey: 'a'},
      {id: 'a', parentId: 'top', orderKey: 'b'},
      {id: 'b', parentId: 'top', orderKey: 'c'},
    ])
    const result = await blockAfterSubtreeRemoval(env.repo.block('b'), 'top')
    expect(result?.id).toBe('a')
  })

  it('returns the parent when the block is the sole child', async () => {
    // top > [parent > [only]]; remove only → parent
    await seedOutline(env.repo, [
      {id: 'top', parentId: null, orderKey: 'a'},
      {id: 'parent', parentId: 'top', orderKey: 'b'},
      {id: 'only', parentId: 'parent', orderKey: 'c'},
    ])
    const result = await blockAfterSubtreeRemoval(env.repo.block('only'), 'top')
    expect(result?.id).toBe('parent')
  })

  it('returns the next sibling when deleting a parent with descendants', async () => {
    // top > [above, parent > [child, c2], below]; remove parent → below
    // This is the screenshot scenario: focus must skip parent's own
    // about-to-vanish subtree and land on the same-depth next sibling.
    await seedOutline(env.repo, [
      {id: 'top', parentId: null, orderKey: 'a'},
      {id: 'above', parentId: 'top', orderKey: 'b'},
      {id: 'parent', parentId: 'top', orderKey: 'c'},
      {id: 'child', parentId: 'parent', orderKey: 'd'},
      {id: 'c2', parentId: 'parent', orderKey: 'e'},
      {id: 'below', parentId: 'top', orderKey: 'f'},
    ])
    const result = await blockAfterSubtreeRemoval(env.repo.block('parent'), 'top')
    expect(result?.id).toBe('below')
  })

  it('returns null when the block is the panel top-level', async () => {
    await seedOutline(env.repo, [
      {id: 'top', parentId: null, orderKey: 'a'},
    ])
    const result = await blockAfterSubtreeRemoval(env.repo.block('top'), 'top')
    expect(result).toBeNull()
  })
})

describe('getLastVisibleDescendant', () => {
  it('descends into the last visible child of an expanded subtree', async () => {
    // top > [a, b > [b1, b2]]; last visible descendant of top = b2
    await seedOutline(env.repo, [
      {id: 'top', parentId: null, orderKey: 'a'},
      {id: 'a', parentId: 'top', orderKey: 'b'},
      {id: 'b', parentId: 'top', orderKey: 'c'},
      {id: 'b1', parentId: 'b', orderKey: 'd'},
      {id: 'b2', parentId: 'b', orderKey: 'e'},
    ])
    const result = await getLastVisibleDescendant(env.repo.block('top'))
    expect(result.id).toBe('b2')
  })

  it('stops at a collapsed mid-tree block (so previousVisibleBlock lands on the collapsed sibling, not inside its hidden subtree)', async () => {
    // 'b' is collapsed; landing-from-above should stop at 'b', not its
    // hidden 'b1'. This is the contract previousVisibleBlock depends on.
    await seedOutline(env.repo, [
      {id: 'top', parentId: null, orderKey: 'a'},
      {id: 'b', parentId: 'top', orderKey: 'b'},
      {id: 'b1', parentId: 'b', orderKey: 'c'},
    ])
    await env.repo.mutate.setProperty({id: 'b', schema: isCollapsedProp, value: true})
    const result = await getLastVisibleDescendant(env.repo.block('b'))
    expect(result.id).toBe('b')
  })

  it('descends from a collapsed entry block when its id matches the panel topLevelBlockId (vim Shift+G regression)', async () => {
    // Repro for "Shift+G jumps to first block instead of last": a panel
    // whose top-level block happens to carry isCollapsedProp=true from
    // its previous life as a child. Without the topLevelBlockId-aware
    // exemption, this returns 'top' — exactly where `gg` lands — so the
    // two bindings appear to do the same thing.
    await seedOutline(env.repo, [
      {id: 'top', parentId: null, orderKey: 'a'},
      {id: 'a', parentId: 'top', orderKey: 'b'},
      {id: 'b', parentId: 'top', orderKey: 'c'},
    ])
    await env.repo.mutate.setProperty({id: 'top', schema: isCollapsedProp, value: true})
    const result = await getLastVisibleDescendant(env.repo.block('top'), 'top')
    expect(result.id).toBe('b')
  })

  it('honors a collapsed scope root when the surface does NOT force it open', async () => {
    // A nested scope root (backlink/embed) renders its collapse flag, so
    // navigation must not descend into its hidden children — returns the
    // root itself rather than a child that isn't rendered.
    await seedOutline(env.repo, [
      {id: 'top', parentId: null, orderKey: 'a'},
      {id: 'a', parentId: 'top', orderKey: 'b'},
      {id: 'b', parentId: 'top', orderKey: 'c'},
    ])
    await env.repo.mutate.setProperty({id: 'top', schema: isCollapsedProp, value: true})
    const result = await getLastVisibleDescendant(env.repo.block('top'), 'top', false)
    expect(result.id).toBe('top')
  })

  it('still honors the collapsed flag on entry when the id does not match topLevelBlockId', async () => {
    // Confirms the exemption is narrowly scoped to the panel root — a
    // collapsed sibling encountered mid-walk still terminates the descent.
    await seedOutline(env.repo, [
      {id: 'top', parentId: null, orderKey: 'a'},
      {id: 'b', parentId: 'top', orderKey: 'b'},
      {id: 'b1', parentId: 'b', orderKey: 'c'},
    ])
    await env.repo.mutate.setProperty({id: 'b', schema: isCollapsedProp, value: true})
    const result = await getLastVisibleDescendant(env.repo.block('b'), 'top')
    expect(result.id).toBe('b')
  })
})

/** Total SQL round-trips the repo has issued. These are the cost unit for
 *  selection extension: every one is a round-trip to the (in production,
 *  OPFS/WASM) database on the keystroke path. */
const sqlCalls = (repo: Repo): number => {
  const m = repo.dbMetrics.snapshot()
  return m.getAll.calls + m.getOptional.calls + m.get.calls + m.execute.calls
}

/** A flat outline `root > b0..b{count-1}`, seeded in one tx. */
const seedFlatOutline = async (repo: Repo, count: number): Promise<void> => {
  await repo.tx(async tx => {
    await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'root'})
    for (let i = 0; i < count; i++) {
      await tx.create({
        id: `b${i}`, workspaceId: WS, parentId: 'root',
        orderKey: `m${String(i).padStart(4, '0')}`, content: `b${i}`,
      })
    }
  }, {scope: ChangeScope.UiState})
}

/** A second Repo over the same db — same rows, empty BlockCache. Models the
 *  cold-cache case (first interaction after load) that the hydration in
 *  `validateSelectionHierarchy` exists for. Read-only here, so the colliding
 *  id generators the `createTestRepo` docblock warns about don't apply. */
const coldRepo = (): Repo => {
  const {repo} = createTestRepo({db: sharedDb.db, user: USER})
  repo.setActiveWorkspaceId(WS)
  return repo
}

describe('validateSelectionHierarchy — hydration cost', () => {
  it('issues no SQL when the ancestor chains are already in cache', async () => {
    // The keystroke path (`extendSelection`) runs this over the WHOLE
    // accumulated range on every Shift+Arrow, twice (once inside
    // `getBlocksInRange`, once in `commitSelectionRange`). Hydrating
    // unconditionally cost 2 round-trips per selected block per press —
    // ~400 queries for a 100-block selection, which measured as the entire
    // SQL cost of extending a selection. The chains are already cached
    // (the blocks are rendered), so the loads were pure waste.
    await seedFlatOutline(env.repo, 30)
    const ids = Array.from({length: 30}, (_, i) => `b${i}`)
    // Warm the chains the way rendering the outline does.
    await validateSelectionHierarchy([...ids], env.repo)

    const before = sqlCalls(env.repo)
    const result = await validateSelectionHierarchy([...ids], env.repo)
    expect(sqlCalls(env.repo) - before).toBe(0)
    expect(result).toEqual(ids)
  })

  it('still hydrates — and still collapses a descendant into its ancestor — on a cold cache', async () => {
    // The skip must be driven by "chain already in cache", not by dropping
    // hydration: with a cold cache `isDescendantOf` walks
    // `cache.getSnapshot(parentId)`, finds nothing, and would keep BOTH the
    // parent and the child.
    await seedOutline(env.repo, [
      {id: 'root', parentId: null, orderKey: 'a'},
      {id: 'parent', parentId: 'root', orderKey: 'b'},
      {id: 'child', parentId: 'parent', orderKey: 'c'},
    ])

    const cold = coldRepo()
    const result = await validateSelectionHierarchy(['parent', 'child'], cold)
    expect(result).toEqual(['parent'])
  })
})

describe('getBlocksInRange — walk cost', () => {
  it('walking BACKWARD does not first walk forward to the end of the document', async () => {
    // Direction was auto-detected by running the forward walk to completion
    // and only then trying backward — so extending a selection UPWARD from
    // the middle of a page re-walked every block BELOW the anchor, every
    // keystroke. Cold cache makes that walk visible: each block it touches
    // costs SQL, so a 6-block range in a 60-block outline must not pay for
    // the ~50 blocks that sit past the anchor.
    await seedFlatOutline(env.repo, 60)

    const cold = coldRepo()
    // Warm only the range we actually traverse, so the assertion measures
    // the WALK's reach rather than one-off hydration of the endpoints.
    const before = sqlCalls(cold)
    const result = await getBlocksInRange('b30', 'b25', 'root', cold)
    const spent = sqlCalls(cold) - before

    expect(result).toEqual(['b25', 'b26', 'b27', 'b28', 'b29', 'b30'])
    // Blocks below b30 are never in the answer; touching them at all means
    // the forward walk ran to the end of the document first. Generous bound
    // — the point is O(range), not O(document).
    expect(spent).toBeLessThan(40)
  })

  it('still finds the endpoint when walking forward', async () => {
    await seedFlatOutline(env.repo, 20)
    expect(await getBlocksInRange('b3', 'b6', 'root', env.repo))
      .toEqual(['b3', 'b4', 'b5', 'b6'])
  })
})
