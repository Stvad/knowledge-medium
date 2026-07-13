// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { definitionSeedsFacet } from '@/data/facets'
import {
  RECENT_BLOCKS_LIMIT,
  pushRecentBlockId,
  recentBlockIdsProp,
} from '../recents.ts'

const WS = 'ws-1'
const PREFS_BLOCK_ID = 'user-prefs'

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (initialIds: string[]): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const { repo } = createTestRepo({
    db: h.db,
    user: {id: 'user-1'},
    extensions: [definitionSeedsFacet.of(recentBlockIdsProp, {source: 'test'})],
  })
  repo.setActiveWorkspaceId(WS)
  await repo.tx(tx => tx.create({
    id: PREFS_BLOCK_ID,
    workspaceId: WS,
    parentId: null,
    orderKey: 'a0',
    content: '',
    properties: {
      [recentBlockIdsProp.name]: recentBlockIdsProp.codec.encode(initialIds),
    },
  }), {scope: ChangeScope.UiState})
  return {h, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

const flush = async (repo: Repo) => {
  await repo.tx(async () => {}, {scope: ChangeScope.UiState})
}

describe('pushRecentBlockId', () => {
  it('pushes a new id to the front of an existing list', async () => {
    env = await setup(['old-1', 'old-2'])
    const block = env.repo.block(PREFS_BLOCK_ID)

    pushRecentBlockId(block, 'new')
    await flush(env.repo)

    expect(block.peekProperty(recentBlockIdsProp))
      .toEqual(['new', 'old-1', 'old-2'])
  })

  it('moves an existing id to the front', async () => {
    env = await setup(['a', 'b', 'c'])
    const block = env.repo.block(PREFS_BLOCK_ID)

    pushRecentBlockId(block, 'b')
    await flush(env.repo)

    expect(block.peekProperty(recentBlockIdsProp)).toEqual(['b', 'a', 'c'])
  })

  it('caps the list at RECENT_BLOCKS_LIMIT', async () => {
    const initial = Array.from({length: RECENT_BLOCKS_LIMIT}, (_, i) => `id-${i}`)
    env = await setup(initial)
    const block = env.repo.block(PREFS_BLOCK_ID)

    pushRecentBlockId(block, 'fresh')
    await flush(env.repo)

    const stored = block.peekProperty(recentBlockIdsProp)!
    expect(stored).toHaveLength(RECENT_BLOCKS_LIMIT)
    expect(stored[0]).toBe('fresh')
    expect(stored).not.toContain(`id-${RECENT_BLOCKS_LIMIT - 1}`)
  })

  it('handles empty initial state', async () => {
    env = await setup([])
    const block = env.repo.block(PREFS_BLOCK_ID)

    pushRecentBlockId(block, 'first')
    await flush(env.repo)

    expect(block.peekProperty(recentBlockIdsProp)).toEqual(['first'])
  })

  it('tags writes with ChangeScope.UiState and source="user" (uploads via standard routing)', async () => {
    // Phase 2 dropped the local-ephemeral source. Recents writes still
    // use ChangeScope.UiState (scope identity is meaningful for undo
    // bucketing and schema validation), but they now upload like any
    // other write. Device-locality is now an emergent property of the
    // recents being scoped to a per-device pref subtree, not of the
    // upload routing being special-cased.
    env = await setup([])
    const block = env.repo.block(PREFS_BLOCK_ID)

    pushRecentBlockId(block, 'first')
    await flush(env.repo)

    const events = await env.h.db.getAll<{scope: string; source: string}>(
      'SELECT scope, source FROM command_events WHERE workspace_id = ? ORDER BY created_at',
      [WS],
    )
    expect(events.at(-1)).toEqual({scope: ChangeScope.UiState, source: 'user'})
  })
})
