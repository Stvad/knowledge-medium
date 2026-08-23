// @vitest-environment happy-dom
/**
 * The banner is the only signal a page has lost its own name, so these drive
 * the real component against a real Repo rather than asserting on mocks: the
 * detection is a live alias query, and the merge is the real mutator.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { aliasesProp, typesProp } from '@/data/properties'
import { PAGE_TYPE } from '@/data/blockTypes'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { RepoContext } from '@/context/repo'
import { aliasDataExtension } from '../dataExtension.ts'
import { DuplicateNameBanner } from '../DuplicateNameBanner.tsx'

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}
/** Later than any `created_at` the helpers below stamp through `repo.tx`. */
const FAR_FUTURE = 9_999_999_999_999

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

/** A second live claimant of a name someone already holds — the state a
 *  local tx cannot produce, because the uniqueness trigger rejects it. Raw
 *  inserts are the shape sync-applied rows arrive in (the trigger's `WHEN`
 *  guard skips `tx_context.source IS NULL`), which is exactly how two devices
 *  creating the same page offline end up co-owning one alias. `createdAt`
 *  orders the claimants, since which one `aliasLookup` returns is the whole
 *  point of these tests. */
const coClaim = async (id: string, content: string, alias: string, createdAt: number) => {
  await sharedDb.db.execute(
    `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json,
      references_json, created_at, updated_at, user_updated_at, created_by, updated_by, deleted)
     VALUES (?, ?, NULL, ?, ?, ?, '[]', ?, ?, ?, 'u', 'u', 0)`,
    [
      id, WS, `k-${id}`, content,
      JSON.stringify({
        [aliasesProp.name]: aliasesProp.codec.encode([alias]),
        [typesProp.name]: typesProp.codec.encode([PAGE_TYPE]),
      }),
      createdAt, createdAt, createdAt,
    ],
  )
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
      // 'My journal' — the squatter's TITLE — survives as an alias. The merge
      // keeps the target's content, so without this the only name the user
      // knew that page by would vanish with nothing pointing at it.
      expect((await repo.load('canonical'))?.properties[aliasesProp.name])
        .toEqual(['Journal', 'Notes', 'My journal'])
    })
    // The other page's content came across, and it is gone.
    expect((await repo.load('kid'))?.parentId).toBe('canonical')
    expect(await repo.load('squatter')).toBeNull()
  })

  it('surfaces the duplicate even when this page is the oldest claimant of its own name', async () => {
    // Co-ownership: this page DOES still hold its name, and `aliasLookup`
    // resolves the alias to it — so the old "is the owner someone else?" test
    // saw nothing to report. But a second live block claims it too, and which
    // one a `[[Journal]]` link lands on is a `created_at` tie-break the user
    // never chose. The page owning its name is not the same as owning it alone.
    await page('canonical', 'Journal', ['Journal'])
    // Younger than `canonical`, so `aliasLookup`'s created_at tie-break picks
    // this page and the rival stays invisible to a single-row lookup.
    await coClaim('rival', 'Their journal', 'Journal', FAR_FUTURE)
    await renderBanner('canonical')

    // "also named", not "named": this page still holds the name, so telling
    // the user links go elsewhere would be false. What is wrong is that the
    // name no longer identifies one page.
    expect(await screen.findByText(/Another page is also named/)).toBeTruthy()
  })

  it('folds every rival, not just the oldest', async () => {
    // Merging one rival while another still claims the name re-trips the
    // uniqueness trigger the moment the survivor writes its alias bag: the tx
    // rolls back, the button re-enables, and every retry fails identically.
    // Both rivals have to go in one transaction or neither can.
    await page('canonical', 'Journal', [])
    await coClaim('rival-a', 'First', 'Journal', 1_000)
    await coClaim('rival-b', 'Second', 'Journal', 2_000)
    await renderBanner('canonical')

    await userEvent.click(await screen.findByRole('button', {name: /merge into this page/i}))

    await waitFor(async () => {
      expect((await repo.load('canonical'))?.properties[aliasesProp.name])
        .toEqual(['Journal', 'First', 'Second'])
    })
    expect(await repo.load('rival-a')).toBeNull()
    expect(await repo.load('rival-b')).toBeNull()
  })

  it('still explains the collision to a viewer, without offering the write', async () => {
    // Links really do resolve to the other page, so a viewer needs to know.
    // Only the merge disappears — it is a write they cannot make.
    await page('canonical', 'Journal', [])
    await page('squatter', 'My journal', ['Journal'])
    vi.spyOn(repo, 'isReadOnly', 'get').mockReturnValue(true)
    await renderBanner('canonical')

    expect(await screen.findByText(/Another page is named/)).toBeTruthy()
    expect(screen.queryByRole('button', {name: /merge into this page/i})).toBeNull()
    expect(screen.getByRole('button', {name: /open it/i})).toBeTruthy()
  })
})
