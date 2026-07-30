// @vitest-environment happy-dom

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { aliasesProp } from '@/data/properties'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo, isBlockDeleted } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { getLayoutSessionBlock, getUIStateBlock } from '@/data/stateBlocks'
import { panelBlockId, allPanelRowsInLayoutOrder } from '@/utils/panelLayoutProjection'
import { __resetLayoutSessionIdForTesting } from '@/utils/layoutSessionId'
import { getOrCreateRecentsPage, recentsPageBlockId } from '@/data/recentsPage.ts'
import { openRecents, openRecentsAction } from '../index.ts'

const WS = 'ws-recents'
const USER: User = {id: 'user-1', name: 'Alice'}

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const { repo } = createTestRepo({db: h.db, user: USER})
  repo.setActiveWorkspaceId(WS)
  return {h, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  __resetLayoutSessionIdForTesting()
  env = await setup()
})

/** Where the desktop "navigator" target (the main panel) currently points,
 *  or `undefined` if no panel has been created yet. Reads the same layout
 *  projection `navigate()` writes through, so this observes where a
 *  `navigateFromGlobalCommand` navigation actually landed — not just what
 *  blockId was requested. */
const currentMainPanelBlockId = async (repo: Repo): Promise<string | undefined> => {
  const uiState = await getUIStateBlock(repo, WS, USER, {})
  const layoutSession = await getLayoutSessionBlock(uiState, repo.activeLayoutSessionId)
  const rows = await repo.query.subtree({id: layoutSession.id}).load()
  const panel = allPanelRowsInLayoutOrder(layoutSession.id, rows)[0]
  return panel ? panelBlockId(panel) : undefined
}

describe('recents navigation resolves the live page (issue #378)', () => {
  it('openRecentsAction lands on a live claimant of the Recents alias, not the dead deterministic id', async () => {
    // Mirrors src/data/test/kernelPage.test.ts's "adopts a live claimant of
    // the CANONICAL alias instead of colliding with it (issue #378)": the
    // canonical Recents page is created, then deleted, and a DIFFERENT live
    // block claims its canonical alias ('Recents') afterward.
    // `getOrCreateKernelPage` (issue #378) adopts that claimant rather than
    // re-minting the deterministic id. Before this fix, both recents call
    // sites navigated straight to `recentsPageBlockId` regardless of live
    // state, landing on the now-dead tombstone.
    const page = await getOrCreateRecentsPage(env.repo, WS)
    const deadId = page.id
    expect(deadId).toBe(recentsPageBlockId(WS))

    await env.repo.tx(async tx => { await tx.delete(deadId) }, {scope: ChangeScope.BlockDefault})
    await env.repo.tx(async tx => {
      await tx.create({id: 'claimant', workspaceId: WS, parentId: null, orderKey: 'z0', content: 'Claimant'})
      await tx.setProperty('claimant', aliasesProp, ['Recents'])
    }, {scope: ChangeScope.BlockDefault})

    const action = openRecentsAction(env.repo)
    await action.handler({uiStateBlock: {} as never}, new CustomEvent('test'))

    await vi.waitFor(async () => {
      expect(await currentMainPanelBlockId(env.repo)).toBe('claimant')
    })
    // The old deterministic-id row stays a tombstone — nothing re-mints it,
    // and nothing navigates there.
    expect(await isBlockDeleted(env.repo, deadId)).toBe(true)
  })

  it('openRecents creates the Recents page on first use rather than navigating to a nonexistent id', async () => {
    expect(await env.repo.exists(recentsPageBlockId(WS))).toBe(false)

    await openRecents(env.repo)

    await vi.waitFor(async () => {
      expect(await currentMainPanelBlockId(env.repo)).toBe(recentsPageBlockId(WS))
    })
  })
})
