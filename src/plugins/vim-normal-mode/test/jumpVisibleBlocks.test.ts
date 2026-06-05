// @vitest-environment node
/**
 * jumpVisibleBlocks is the count/boundary core behind Ctrl-d / Ctrl-u. The
 * single-step visible-traversal it builds on (next/previousVisibleBlock) lives
 * in utils/selection; this pins what jumpVisibleBlocks adds on top — counting N
 * steps, clamping at the scope edge, and reporting "no movement" as null.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BlockCache } from '@/data/blockCache'
import { ChangeScope } from '@/data/api'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { jumpVisibleBlocks } from '../actions.ts'

const WS = 'ws-1'
const ROOT = 'root'
// A flat, fully-visible outline: root → c0..c11 (single-char order keys so they
// sort correctly). c0 is the first navigable block, c11 the last.
const COUNT = 12
const childId = (i: number) => `c${i}`

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = new Repo({
    db: sharedDb.db,
    cache: new BlockCache(),
    user: {id: 'user-1'},
    registerKernelProcessors: false,
    startSyncObserver: false,
  })
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: ROOT, workspaceId: WS, parentId: null, orderKey: 'a'})
    for (let i = 0; i < COUNT; i++) {
      await tx.create({
        id: childId(i),
        workspaceId: WS,
        parentId: ROOT,
        orderKey: String.fromCharCode(97 + i), // 'a'..'l'
        content: childId(i),
      })
    }
  }, {scope: ChangeScope.BlockDefault})
})
afterEach(() => { repo.stopSyncObserver() })

const jump = (from: string, count: number, direction: 'up' | 'down') =>
  jumpVisibleBlocks(repo.block(from), ROOT, count, direction)

describe('jumpVisibleBlocks', () => {
  it('lands exactly `count` visible blocks down', async () => {
    expect((await jump('c0', 8, 'down'))?.id).toBe('c8')
  })

  it('lands exactly `count` visible blocks up', async () => {
    expect((await jump('c11', 8, 'up'))?.id).toBe('c3')
  })

  it('clamps to the last visible block when fewer than `count` remain', async () => {
    // c5 has only 6 blocks below it; a jump of 8 stops at the boundary.
    expect((await jump('c5', 8, 'down'))?.id).toBe('c11')
  })

  it('clamps to the scope root jumping up past the first child', async () => {
    // The panel's top block is itself navigable, so jumping up past c0 lands
    // on the scope root rather than stopping at c0.
    expect((await jump('c5', 8, 'up'))?.id).toBe(ROOT)
  })

  it('returns null when already at the bottom boundary (no movement)', async () => {
    expect(await jump('c11', 8, 'down')).toBeNull()
  })

  it('returns null when already at the top boundary — the scope root (no movement)', async () => {
    expect(await jump(ROOT, 8, 'up')).toBeNull()
  })
})
