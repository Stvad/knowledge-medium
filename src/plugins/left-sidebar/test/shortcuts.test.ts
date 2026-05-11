// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { getUserBlock } from '@/data/globalState.ts'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { journalBlockId } from '@/data/dailyNotes.ts'
import { getOrCreateShortcutsBlock } from '../shortcuts.ts'

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
    registerKernelProcessors: false,
  })
  repo.setActiveWorkspaceId(WS)
  return repo
}

const setup = async (): Promise<Harness> => {
  const h = await createTestDb()
  return {h, repo: createRepo(h)}
}

const shortcutChildren = async (repo: Repo, shortcutsId: string) => {
  const ids = await repo.block(shortcutsId).childIds.load()
  return Promise.all(ids.map(id => repo.block(id).load()))
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

describe('getOrCreateShortcutsBlock', () => {
  it('seeds a newly-created Shortcuts block with a Journal shortcut', async () => {
    const userBlock = await getUserBlock(env.repo, WS, USER)
    const shortcuts = await getOrCreateShortcutsBlock(userBlock)

    expect(shortcuts.peek()?.content).toBe('Shortcuts')

    const children = await shortcutChildren(env.repo, shortcuts.id)
    expect(children).toHaveLength(1)
    expect(children[0]).toMatchObject({
      parentId: shortcuts.id,
      workspaceId: WS,
      content: 'Journal',
      references: [{id: journalBlockId(WS), alias: 'Journal'}],
    })
  })

  it('seeds an existing empty Shortcuts block once', async () => {
    const userBlock = await getUserBlock(env.repo, WS, USER)
    await env.repo.tx(tx => tx.create({
      id: 'legacy-shortcuts',
      workspaceId: WS,
      parentId: userBlock.id,
      orderKey: 'a0',
      content: 'Shortcuts',
    }), {scope: ChangeScope.UserPrefs})

    const shortcuts = await getOrCreateShortcutsBlock(userBlock)
    const [seeded] = await shortcutChildren(env.repo, shortcuts.id)
    expect(seeded?.references).toEqual([{id: journalBlockId(WS), alias: 'Journal'}])

    await env.repo.tx(tx => tx.delete(seeded!.id), {scope: ChangeScope.UserPrefs})

    const freshRepo = createRepo(env.h)
    const freshUserBlock = await getUserBlock(freshRepo, WS, USER)
    const freshShortcuts = await getOrCreateShortcutsBlock(freshUserBlock)
    expect(await freshRepo.block(freshShortcuts.id).childIds.load()).toEqual([])
  })
})
