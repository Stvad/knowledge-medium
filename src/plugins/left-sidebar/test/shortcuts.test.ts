// @vitest-environment node

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { getUserBlock } from '@/data/stateBlocks.js'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { journalBlockId } from '@/plugins/daily-notes'
import {
  getOrCreateShortcutsBlock,
  journalShortcutBlockId,
  shortcutsBlockId,
} from '../shortcuts.ts'

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}

interface Harness {
  h: TestDb
  repo: Repo
}

const createRepo = (h: TestDb): Repo => {
  const repo = new Repo({
    db: h.db,
    cache: new BlockCache(),
    user: USER,
  })
  repo.setActiveWorkspaceId(WS)
  return repo
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  return {h, repo: createRepo(h)}
}

const shortcutChildren = async (repo: Repo, shortcutsId: string) => {
  const ids = await repo.block(shortcutsId).childIds.load()
  return Promise.all(ids.map(id => repo.block(id).load()))
}

const countLiveByContent = async (h: TestDb, parentId: string, content: string): Promise<number> => {
  const rows = await h.db.getAll<{count: number}>(
    'SELECT COUNT(*) AS count FROM blocks WHERE parent_id = ? AND content = ? AND deleted = 0',
    [parentId, content],
  )
  return rows[0]?.count ?? 0
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })
// Dispose the per-test Repo's sync observer so its db.onChange subscription
// doesn't leak onto the shared DB (closed once in afterAll).
afterEach(() => { env.repo.stopSyncObserver() })

describe('deterministic ids', () => {
  it('shortcutsBlockId is stable for a given user-page id', () => {
    expect(shortcutsBlockId('user-page-a')).toBe(shortcutsBlockId('user-page-a'))
    expect(shortcutsBlockId('user-page-a')).not.toBe(shortcutsBlockId('user-page-b'))
  })

  it('journalShortcutBlockId is stable for a given shortcuts id', () => {
    expect(journalShortcutBlockId('shortcuts-a')).toBe(journalShortcutBlockId('shortcuts-a'))
    expect(journalShortcutBlockId('shortcuts-a')).not.toBe(journalShortcutBlockId('shortcuts-b'))
  })
})

describe('getOrCreateShortcutsBlock', () => {
  it('creates Shortcuts with a Journal shortcut when missing', async () => {
    const userBlock = await getUserBlock(env.repo, WS, USER)
    const shortcuts = await getOrCreateShortcutsBlock(userBlock)

    expect(shortcuts.id).toBe(shortcutsBlockId(userBlock.id))
    expect(shortcuts.peek()?.content).toBe('Shortcuts')

    const children = await shortcutChildren(env.repo, shortcuts.id)
    expect(children).toHaveLength(1)
    expect(children[0]).toMatchObject({
      id: journalShortcutBlockId(shortcuts.id),
      parentId: shortcuts.id,
      workspaceId: WS,
      content: '[[Journal]]',
      references: [{id: journalBlockId(WS), alias: 'Journal'}],
    })
  })

  it('is idempotent: second call returns the same row, no duplicate children', async () => {
    const userBlock = await getUserBlock(env.repo, WS, USER)
    const a = await getOrCreateShortcutsBlock(userBlock)
    const b = await getOrCreateShortcutsBlock(userBlock)
    expect(a.id).toBe(b.id)

    expect(await countLiveByContent(env.h, userBlock.id, 'Shortcuts')).toBe(1)
    expect(await countLiveByContent(env.h, a.id, '[[Journal]]')).toBe(1)
  })

  it('returns an existing Shortcuts block without adding children', async () => {
    const userBlock = await getUserBlock(env.repo, WS, USER)
    const id = shortcutsBlockId(userBlock.id)
    await env.repo.tx(tx => tx.create({
      id,
      workspaceId: WS,
      parentId: userBlock.id,
      orderKey: 'a0',
      content: 'Shortcuts',
    }), {scope: ChangeScope.UserPrefs})

    const shortcuts = await getOrCreateShortcutsBlock(userBlock)
    expect(shortcuts.id).toBe(id)
    expect(await env.repo.block(shortcuts.id).childIds.load()).toEqual([])
  })

  it('two Repo instances on the same db converge to the same row', async () => {
    // Models the cross-client race: each device's Repo sees no
    // shortcuts row yet, both call get-or-create, only one row exists
    // afterwards because both compute the same deterministic id.
    const repoB = createRepo(env.h)

    const userBlockA = await getUserBlock(env.repo, WS, USER)
    const userBlockB = await getUserBlock(repoB, WS, USER)
    expect(userBlockA.id).toBe(userBlockB.id)

    const [shortcutsA, shortcutsB] = await Promise.all([
      getOrCreateShortcutsBlock(userBlockA),
      getOrCreateShortcutsBlock(userBlockB),
    ])

    expect(shortcutsA.id).toBe(shortcutsB.id)
    expect(await countLiveByContent(env.h, userBlockA.id, 'Shortcuts')).toBe(1)
    expect(await countLiveByContent(env.h, shortcutsA.id, '[[Journal]]')).toBe(1)
  })

  it('does not duplicate when a fresh Repo runs after a previous session created the row', async () => {
    // Models the workspace-creation / first-sync ordering: the local
    // shortcuts row already exists on disk (from a prior session or
    // from PowerSync), and a freshly-constructed Repo on app launch
    // hits the row again. Without deterministic ids the lodash memo
    // would already have been keyed off the prior instanceId, so the
    // new Repo would race-create a duplicate.
    const userBlockA = await getUserBlock(env.repo, WS, USER)
    const shortcutsA = await getOrCreateShortcutsBlock(userBlockA)

    const repoB = createRepo(env.h)
    const userBlockB = await getUserBlock(repoB, WS, USER)
    const shortcutsB = await getOrCreateShortcutsBlock(userBlockB)

    expect(shortcutsB.id).toBe(shortcutsA.id)
    expect(await countLiveByContent(env.h, userBlockA.id, 'Shortcuts')).toBe(1)
  })

  it('restores a soft-deleted Shortcuts block and reseeds the Journal child', async () => {
    const userBlock = await getUserBlock(env.repo, WS, USER)
    const shortcuts = await getOrCreateShortcutsBlock(userBlock)

    await env.repo.tx(async tx => {
      const children = await tx.childrenOf(shortcuts.id, WS)
      for (const child of children) await tx.delete(child.id)
      await tx.delete(shortcuts.id)
    }, {scope: ChangeScope.UserPrefs})

    // Use a fresh Repo so the lodash memo (keyed on repo.instanceId)
    // misses and the get-or-create path actually runs. This mirrors
    // production: tombstone-restore only matters across Repo restarts.
    const repoB = createRepo(env.h)
    const userBlockB = await getUserBlock(repoB, WS, USER)
    const restored = await getOrCreateShortcutsBlock(userBlockB)
    expect(restored.id).toBe(shortcuts.id)
    expect(restored.peek()?.deleted).toBe(false)

    const children = await shortcutChildren(repoB, restored.id)
    expect(children).toHaveLength(1)
    expect(children[0]).toMatchObject({
      id: journalShortcutBlockId(restored.id),
      content: '[[Journal]]',
      references: [{id: journalBlockId(WS), alias: 'Journal'}],
    })
  })
})
