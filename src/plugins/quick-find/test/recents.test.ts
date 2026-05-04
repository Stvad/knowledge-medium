// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
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
    id: PREFS_BLOCK_ID,
    workspaceId: WS,
    parentId: null,
    orderKey: 'a0',
    content: '',
    properties: {
      [recentBlockIdsProp.name]: recentBlockIdsProp.codec.encode(initialIds),
    },
  }), {scope: ChangeScope.UserPrefs})
  return {h, repo}
}

let env: Harness
afterEach(async () => { await env?.h.cleanup() })

const flush = async (repo: Repo) => {
  await repo.tx(async () => {}, {scope: ChangeScope.UserPrefs})
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

  it('writes through the UserPrefs scope', async () => {
    env = await setup([])
    const block = env.repo.block(PREFS_BLOCK_ID)

    pushRecentBlockId(block, 'first')
    await flush(env.repo)

    const events = await env.h.db.getAll<{scope: string; source: string}>(
      'SELECT scope, source FROM command_events WHERE workspace_id = ? ORDER BY created_at',
      [WS],
    )
    expect(events.at(-1)).toEqual({scope: ChangeScope.UserPrefs, source: 'user'})
  })
})
