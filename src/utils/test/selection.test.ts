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
  getLastVisibleDescendant,
  nextVisibleBlock,
  previousVisibleBlock,
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

  it('overrides a forced-open explicit ancestor in getLastVisibleDescendant', async () => {
    await seedOutline(env.repo, [
      {id: 'top', parentId: null, orderKey: 'a'},
      {id: 'a', parentId: 'top', orderKey: 'b'},
      {id: 'a1', parentId: 'a', orderKey: 'c'},
      {id: 'a2', parentId: 'a', orderKey: 'd'},
    ])
    await env.repo.mutate.setProperty({id: 'a', schema: isCollapsedProp, value: true})
    const result = await getLastVisibleDescendant(
      env.repo.block('top'),
      'top',
      false,
      ['a'],
    )
    expect(result.id).toBe('a2')
  })
})

describe('previous / next visible block', () => {
  it('uses force-open block ids for both directions in a collapsed subtree', async () => {
    await seedOutline(env.repo, [
      {id: 'top', parentId: null, orderKey: 'a'},
      {id: 'a', parentId: 'top', orderKey: 'b'},
      {id: 'a1', parentId: 'a', orderKey: 'c'},
      {id: 'a2', parentId: 'top', orderKey: 'd'},
    ])
    await env.repo.mutate.setProperty({id: 'a', schema: isCollapsedProp, value: true})

    const nextWithoutForceOpen = await nextVisibleBlock(env.repo.block('a'), 'top', false)
    expect(nextWithoutForceOpen?.id).toBe('a2')

    const nextWithForceOpen = await nextVisibleBlock(env.repo.block('a'), 'top', false, ['a'])
    expect(nextWithForceOpen?.id).toBe('a1')

    const prevWithoutForceOpen = await previousVisibleBlock(env.repo.block('a2'), 'top', false)
    expect(prevWithoutForceOpen?.id).toBe('a')

    const prevWithForceOpen = await previousVisibleBlock(env.repo.block('a2'), 'top', false, ['a'])
    expect(prevWithForceOpen?.id).toBe('a1')
  })
})
