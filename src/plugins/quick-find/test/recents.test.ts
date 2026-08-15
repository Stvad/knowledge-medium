// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ChangeScope, type BlockData } from '@/data/api'
import { aliasesProp, typesProp } from '@/data/properties.js'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { definitionSeedsFacet } from '@/data/facets'
import {
  RECENT_BLOCKS_LIMIT,
  pushRecentBlockId,
  recentBlockIdsProp,
  recentItemFromBlockData,
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

describe('recentItemFromBlockData', () => {
  const NO_OPAQUE: ReadonlySet<string> = new Set()
  const blockData = (overrides: Partial<BlockData>): BlockData => ({
    id: 'block-1',
    workspaceId: WS,
    parentId: null,
    orderKey: 'a0',
    content: '',
    properties: {},
    references: [],
    createdAt: 1,
    updatedAt: 1,
    userUpdatedAt: 1,
    createdBy: 'u',
    updatedBy: 'u',
    deleted: false,
    ...overrides,
  })

  it('carries the parent edge and the types a row needs to show context', () => {
    // Both are read off `BlockData` the loader already has. The parent
    // edge is what tells a genuine root from a block whose ancestor walk
    // was cut; the types are what the row shows about what it IS.
    expect(recentItemFromBlockData('block-1', blockData({
      content: 'Ada Lovelace',
      parentId: 'people-page',
      properties: {[typesProp.name]: ['person']},
    }), NO_OPAQUE)).toEqual({
      blockId: 'block-1',
      label: 'Ada Lovelace',
      parentId: 'people-page',
      typeIds: ['person'],
    })
  })

  it('prefers an alias over the content, as the search rows do', () => {
    expect(recentItemFromBlockData('block-1', blockData({
      content: 'first line of body text',
      properties: {[aliasesProp.name]: ['Project Alpha']},
    }), NO_OPAQUE).label).toBe('Project Alpha')
  })

  it('falls through a blank alias instead of rendering a label-less row', () => {
    // A raw properties-bag write (agent verb, importer, sync-applied row)
    // can leave a blank or non-string first alias. Taking `aliases[0]`
    // unconditionally puts an invisible row in the Recent group.
    expect(recentItemFromBlockData('block-1', blockData({
      content: 'Ada Lovelace',
      properties: {[aliasesProp.name]: ['   ']},
    }), NO_OPAQUE).label).toBe('Ada Lovelace')
  })

  // The MRU never passes through the search merge point, so it is the one
  // list where an opaque block arrives unfiltered. It keeps its row — you
  // were just editing that extension — but the bytes are not a label.
  it('does not use an opaque block\'s content as its label', () => {
    const item = recentItemFromBlockData('block-1', blockData({
      content: 'export const activate = () => {/* … */}',
      properties: {[typesProp.name]: ['extension']},
    }), new Set(['extension']))
    expect(item.label).toBe('block-1')
  })

  it('still labels an opaque block by its alias when it has one', () => {
    const item = recentItemFromBlockData('block-1', blockData({
      content: 'export const activate = () => {}',
      properties: {
        [typesProp.name]: ['extension'],
        [aliasesProp.name]: ['Strength Tracker'],
      },
    }), new Set(['extension']))
    expect(item.label).toBe('Strength Tracker')
  })

  it('survives a malformed types value rather than dropping the row', () => {
    // `getBlockTypes` would throw here; a throw inside the recents loop
    // empties the whole Recent group.
    expect(recentItemFromBlockData('block-1', blockData({
      content: 'Ada Lovelace',
      properties: {[typesProp.name]: 'person'},
    }), NO_OPAQUE).typeIds).toEqual([])
  })
})
