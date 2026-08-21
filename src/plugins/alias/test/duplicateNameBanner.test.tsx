// @vitest-environment happy-dom
/**
 * The banner is the only signal a page has lost its own name, so these drive
 * the real component against a real Repo rather than asserting on mocks: the
 * detection is a live alias query, and the merge is the real mutator.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { aliasesProp } from '@/data/properties'
import { PAGE_TYPE } from '@/data/blockTypes'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { RepoContext } from '@/context/repo'
import { aliasDataExtension } from '../dataExtension.ts'
import { DuplicateNameBanner } from '../DuplicateNameBanner.tsx'

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: USER, extensions: [aliasDataExtension]}).repo
  repo.setActiveWorkspaceId(WS)
})
afterEach(() => { cleanup() })

const page = async (id: string, content: string, aliases: string[]): Promise<void> => {
  await repo.tx(async tx => {
    await tx.create({id, workspaceId: WS, parentId: null, orderKey: id, content})
    if (aliases.length > 0) await tx.setProperty(id, aliasesProp, aliases)
    await repo.addTypeInTx(tx, id, PAGE_TYPE, {}, repo.snapshotTypeRegistries())
  }, {scope: ChangeScope.BlockDefault})
}

const renderBanner = async (id: string) => {
  await repo.block(id).load()
  return render(
    <RepoContext.Provider value={repo}>
      <DuplicateNameBanner block={repo.block(id)}/>
    </RepoContext.Provider>,
  )
}

describe('DuplicateNameBanner', () => {
  it('stays silent when this page owns its own name', async () => {
    await page('canonical', 'Journal', ['Journal'])
    await renderBanner('canonical')
    // Prove the negative is not just "nothing rendered yet": the query has to
    // settle before absence means anything.
    await waitFor(() => { expect(screen.queryByRole('button', {name: /merge/i})).toBeNull() })
    expect(screen.queryByText(/Another page is named/)).toBeNull()
  })

  it('surfaces the duplicate when another live block holds the name', async () => {
    await page('canonical', 'Journal', [])
    await page('squatter', 'My journal', ['Journal'])
    await renderBanner('canonical')

    expect(await screen.findByText(/Another page is named/)).toBeTruthy()
  })

  it('merging folds the other page in and brings the name back', async () => {
    await page('canonical', 'Journal', [])
    await page('squatter', 'My journal', ['Journal', 'Notes'])
    await repo.mutate.createChild({parentId: 'squatter', id: 'kid', content: 'a thought'})
    await renderBanner('canonical')

    await userEvent.click(await screen.findByRole('button', {name: /merge into this page/i}))

    await waitFor(async () => {
      expect((await repo.load('canonical'))?.properties[aliasesProp.name]).toEqual(['Journal', 'Notes'])
    })
    // The other page's content came across, and it is gone.
    expect((await repo.load('kid'))?.parentId).toBe('canonical')
    expect(await repo.load('squatter')).toBeNull()
  })
})
