import { beforeEach, describe, expect, it } from 'vitest'
import { BlockCache } from '@/data/blockCache'
import { ChangeScope, type User } from '@/data/api'
import { Repo } from '@/data/repo'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { blockAfterSubtreeRemoval } from '@/utils/selection.js'

const WS = 'ws-1'
const USER: User = {id: 'user-1'}

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  const h = await createTestDb()
  const repo = new Repo({
    db: h.db,
    cache: new BlockCache(),
    user: USER,
    registerKernelProcessors: false,
  })
  repo.setActiveWorkspaceId(WS)
  return {h, repo}
}

let env: Harness

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
