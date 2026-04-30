// @vitest-environment node
/**
 * Tests for the `pushRecentBlockId` UI-state helper. The helper
 * fire-and-forgets a `Block.set(recentBlockIdsProp, …)` write; the
 * scope is `ChangeScope.UiState`, so the write is local-ephemeral
 * (not synced, not undoable) per spec §5.8.
 *
 * Coverage:
 *   - Push a new id to the front of an existing list
 *   - Move an existing id to the front (dedup, no growth)
 *   - Cap the list at RECENT_BLOCKS_LIMIT
 *   - Empty initial state
 *
 * Replaces deleted `src/data/test/pushRecentBlockId.test.ts`, which
 * mocked the legacy Block facade with `dataSync()` + `setProperty`.
 * The new test goes through the real `repo.mutate.setProperty` path
 * via `Block.set` against `createTestDb`.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/internals/repo'
import {
  RECENT_BLOCKS_LIMIT,
  pushRecentBlockId,
  recentBlockIdsProp,
} from '@/data/properties'

const WS = 'ws-1'
const UI_BLOCK_ID = 'ui-state'

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (initialIds: string[]): Promise<Harness> => {
  const h = await createTestDb()
  const cache = new BlockCache()
  let timeCursor = 1700_000_000_000
  let idCursor = 0
  const repo = new Repo({
    db: h.db,
    cache,
    user: {id: 'user-1'},
    now: () => ++timeCursor,
    newId: () => `gen-${++idCursor}`,
  })
  await repo.tx(tx => tx.create({
    id: UI_BLOCK_ID,
    workspaceId: WS,
    parentId: null,
    orderKey: 'a0',
    content: '',
    properties: {
      [recentBlockIdsProp.name]: recentBlockIdsProp.codec.encode(initialIds),
    },
  }), {scope: ChangeScope.BlockDefault})
  return {h, repo}
}

let env: Harness
afterEach(async () => { await env?.h.cleanup() })

/** Drive the fire-and-forget write to completion. The helper queues
 *  `repo.mutate.setProperty` without awaiting; an empty UI-state tx
 *  serializes behind the in-flight write so the cache reflects it
 *  by the time we read. */
const flush = async (repo: Repo) => {
  await repo.tx(async () => {/* serializing barrier */}, {scope: ChangeScope.UiState})
}

describe('pushRecentBlockId', () => {
  it('pushes a new id to the front of an existing list', async () => {
    env = await setup(['old-1', 'old-2'])
    const block = env.repo.block(UI_BLOCK_ID)

    pushRecentBlockId(block, 'new')
    await flush(env.repo)

    expect(block.peekProperty(recentBlockIdsProp))
      .toEqual(['new', 'old-1', 'old-2'])
  })

  it('moves an existing id to the front (dedup, no growth)', async () => {
    env = await setup(['a', 'b', 'c'])
    const block = env.repo.block(UI_BLOCK_ID)

    pushRecentBlockId(block, 'b')
    await flush(env.repo)

    expect(block.peekProperty(recentBlockIdsProp)).toEqual(['b', 'a', 'c'])
  })

  it('caps the list at RECENT_BLOCKS_LIMIT', async () => {
    const initial = Array.from({length: RECENT_BLOCKS_LIMIT}, (_, i) => `id-${i}`)
    env = await setup(initial)
    const block = env.repo.block(UI_BLOCK_ID)

    pushRecentBlockId(block, 'fresh')
    await flush(env.repo)

    const stored = block.peekProperty(recentBlockIdsProp)!
    expect(stored).toHaveLength(RECENT_BLOCKS_LIMIT)
    expect(stored[0]).toBe('fresh')
    expect(stored).not.toContain(`id-${RECENT_BLOCKS_LIMIT - 1}`)
  })

  it('handles empty initial state', async () => {
    env = await setup([])
    const block = env.repo.block(UI_BLOCK_ID)

    pushRecentBlockId(block, 'first')
    await flush(env.repo)

    expect(block.peekProperty(recentBlockIdsProp)).toEqual(['first'])
  })
})
