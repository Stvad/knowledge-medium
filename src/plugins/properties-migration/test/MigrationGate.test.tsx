// @vitest-environment happy-dom
/**
 * The blocking dialog, driven by the synced claim.
 *
 * Against a REAL repo and the REAL sync observer rather than a stubbed hook:
 * the whole design rests on a claim written by another device reaching this one
 * and raising the dialog with nothing armed in advance, and a test that mocks
 * the subscription cannot tell whether that happens.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { RepoContext } from '@/context/repo.js'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { BLOCKS_SYNCED_RAW_TABLE, blockToSyncedRowParams } from '@/data/blockSchema'
import { MIGRATION_CLAIM_TYPE } from '@/data/blockTypes'
import {
  addBlockTypeToProperties,
  migrationClaimantProp,
  migrationClaimedAtProp,
  migrationCompletedAtProp,
} from '@/data/properties'
import { graphBackfillClaimBlockId } from '@/data/internals/graphBackfillClaim'
import { PROPERTY_CELL_BACKFILL_ID } from '@/data/internals/propertyCellBackfill'
import { MigrationGate } from '../MigrationGate.tsx'
import { setLocalMigrationRun } from '../localRunMessage.ts'

const WS = 'ws-migration-gate'
const OTHER_WS = 'ws-migration-gate-other'
const CLAIM_ID = graphBackfillClaimBlockId(WS, PROPERTY_CELL_BACKFILL_ID)

let sharedDb: TestDb
let repo: Repo

const claimProperties = (
  {completed = false, claimantId = 'peer-device', claimedAt = 1}:
    {completed?: boolean; claimantId?: string; claimedAt?: number} = {},
): Record<string, unknown> => addBlockTypeToProperties({
  [migrationClaimantProp.name]: claimantId,
  [migrationClaimedAtProp.name]: claimedAt,
  ...(completed ? {[migrationCompletedAtProp.name]: 2} : {}),
}, MIGRATION_CLAIM_TYPE)

/** A claim this device already had before the app started: the reload case. */
const seedClaimInBlocks = async (
  opts: Parameters<typeof claimProperties>[0] & {workspaceId?: string} = {},
): Promise<void> => {
  await sharedDb.db.execute(
    `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
       properties_json, deleted, created_at, updated_at, user_updated_at,
       created_by, updated_by)
     VALUES (?, ?, NULL, 'k-claim', ?, ?, 0, 1, 1, 1, 'user-1', 'user-1')`,
    [CLAIM_ID, opts.workspaceId ?? WS, PROPERTY_CELL_BACKFILL_ID,
     JSON.stringify(claimProperties(opts))],
  )
}

/** A claim a PEER wrote, delivered the way a peer's write actually arrives. */
const deliverClaimBySync = async (
  opts: Parameters<typeof claimProperties>[0] = {},
): Promise<void> => {
  await sharedDb.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToSyncedRowParams({
    id: CLAIM_ID, workspaceId: WS, parentId: null, orderKey: 'k-claim',
    content: PROPERTY_CELL_BACKFILL_ID, properties: claimProperties(opts), references: [],
    createdAt: 1, updatedAt: 5, userUpdatedAt: 5, createdBy: 'user-1', updatedBy: 'user-1',
    deleted: false,
  }))
  await sharedDb.db.execute(
    'INSERT INTO blocks_synced_changes (id, op) VALUES (?, \'upsert\')', [CLAIM_ID],
  )
  await act(async () => { await repo.startSyncObserver({throttleMs: 0}).flush() })
}

const renderGate = (): void => {
  render(<RepoContext.Provider value={repo}><MigrationGate /></RepoContext.Provider>)
}

const dialog = (): HTMLElement | null => screen.queryByRole('dialog')

/** The claim row has been READ, so "no dialog" is a verdict rather than a
 *  render that got there first. `useHandle` kicks off the load on mount, so
 *  every absence assertion below is trivially true until this settles. */
const claimHasBeenRead = async (): Promise<void> => {
  await waitFor(() => { expect(repo.block(CLAIM_ID).peek()).not.toBeUndefined() })
}

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  setLocalMigrationRun(null)
  repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}}).repo
  repo.setActiveWorkspaceId(WS)
})
afterEach(() => {
  cleanup()
  setLocalMigrationRun(null)
})

describe('while the migration holds this workspace', () => {
  it('puts the dialog up for a claim this device already has', async () => {
    // The reload case: a tab opened midway through the run has no session state
    // to re-arm, and reads the claim it already has.
    await seedClaimInBlocks()

    renderGate()

    expect(await screen.findByRole('dialog')).toHaveTextContent(/Migrating properties to blocks/)
  })

  it('puts it up when a PEER\'s claim arrives, with nothing armed in advance', async () => {
    renderGate()
    await claimHasBeenRead()
    expect(dialog()).toBeNull()

    await deliverClaimBySync()

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('takes it down when the run records finishing', async () => {
    await seedClaimInBlocks()
    renderGate()
    await screen.findByRole('dialog')

    await deliverClaimBySync({completed: true})

    await waitFor(() => { expect(dialog()).toBeNull() })
  })

  it('stays out of the way for a COMPLETED claim — that is a record, not a run', async () => {
    await seedClaimInBlocks({completed: true})

    renderGate()

    await claimHasBeenRead()
    expect(dialog()).toBeNull()
  })

  it('ignores a row at our claim id that belongs to ANOTHER workspace', async () => {
    // The id is derived from the workspace, but a row can still arrive at it
    // owned by someone else — and a modal raised by one would be unrecoverable
    // from inside this workspace.
    await seedClaimInBlocks({workspaceId: OTHER_WS})

    renderGate()

    await claimHasBeenRead()
    expect(repo.block(CLAIM_ID).peek()).toMatchObject({workspaceId: OTHER_WS})
    expect(dialog()).toBeNull()
  })

  it('cannot be dismissed', async () => {
    await seedClaimInBlocks()
    renderGate()
    await screen.findByRole('dialog')

    await userEvent.keyboard('{Escape}')

    expect(dialog()).toBeInTheDocument()
  })

  it('says what THIS device is doing, and only that a peer is converting otherwise', async () => {
    await seedClaimInBlocks()
    renderGate()
    expect(await screen.findByRole('dialog'))
      .toHaveTextContent(/Another device is converting this workspace/)

    act(() => {
      setLocalMigrationRun({workspaceId: WS, message: 'Switching this workspace to property blocks…'})
    })

    expect(dialog()).toHaveTextContent(/Switching this workspace to property blocks/)
    expect(dialog()).not.toHaveTextContent(/Another device is converting/)
  })

  it('does not report a run on a DIFFERENT workspace as this one\'s progress', async () => {
    // Two situations — a run this device started over there, and a peer's claim
    // over here — and the operator reading one as the other would be told their
    // own run is what is blocking a workspace it never touched.
    await seedClaimInBlocks()
    renderGate()
    await screen.findByRole('dialog')

    act(() => {
      setLocalMigrationRun({workspaceId: OTHER_WS, message: 'Converting the other one…'})
    })

    expect(dialog()).toHaveTextContent(/Another device is converting this workspace/)
    expect(dialog()).not.toHaveTextContent(/Converting the other one/)
  })
})

describe('undo, which the dialog itself cannot cover', () => {
  // The shortcut resolver keeps a `global` carve-out so app-wide chords stay
  // reachable while a modal is up, and undo is registered there — so cmd-Z
  // fires straight through this dialog and would restore a whole pre-migration
  // row over children the pass has since written.
  const recordAnUndoableEdit = async (): Promise<void> => {
    await repo.tx(async tx => {
      await tx.create({
        id: 'target', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'before',
      })
    }, {scope: ChangeScope.BlockDefault, description: 'seed'})
  }

  it('is untouched while nothing holds the workspace', async () => {
    // The mount is always there; only a held claim may take undo away.
    await recordAnUndoableEdit()
    renderGate()
    await claimHasBeenRead()
    expect(dialog()).toBeNull()

    expect(await repo.undo()).toBe(true)

    expect(repo.undoManagerFor(WS).depths(ChangeScope.BlockDefault).undo).toBe(0)
    expect(await sharedDb.db.getOptional(
      'SELECT content FROM blocks WHERE id = ? AND deleted = 0', ['target'],
    )).toBeNull()
  })

  it('is refused while the dialog is up, and the history is gone when it clears', async () => {
    await recordAnUndoableEdit()
    expect(repo.undoManagerFor(WS).depths(ChangeScope.BlockDefault).undo).toBe(1)
    await seedClaimInBlocks()
    renderGate()
    await screen.findByRole('dialog')

    expect(await repo.undo()).toBe(false)
    expect(await sharedDb.db.getOptional<{content: string}>(
      'SELECT content FROM blocks WHERE id = ?', ['target'],
    )).toMatchObject({content: 'before'})

    await deliverClaimBySync({completed: true})
    await waitFor(() => { expect(dialog()).toBeNull() })

    // Emptied, not handed back: those entries describe rows the migration has
    // rewritten. Until now only the device that RAN the pass dropped its own.
    expect(repo.undoManagerFor(WS).depths(ChangeScope.BlockDefault).undo).toBe(0)
  })
})

describe('the way out of a claim nobody will release', () => {
  const claimIsLive = async (): Promise<boolean> =>
    (await sharedDb.db.getOptional<{deleted: number}>(
      'SELECT deleted FROM blocks WHERE id = ?', [CLAIM_ID],
    ))?.deleted === 0

  const openTheRelease = async (): Promise<void> => {
    await screen.findByRole('dialog')
    await userEvent.click(screen.getByRole('button', {name: /nothing is running/i}))
  }

  it('does not release until the user confirms, and says what they are agreeing to', async () => {
    await seedClaimInBlocks()
    renderGate()

    await openTheRelease()

    expect(dialog()).toHaveTextContent(/releasing a live claim frees a second device/i)
    expect(await claimIsLive()).toBe(true)
  })

  it('clears a claim the user confirms, which takes the dialog down everywhere', async () => {
    await seedClaimInBlocks()
    renderGate()
    await openTheRelease()

    await userEvent.click(screen.getByRole('button', {name: /release the claim/i}))

    await waitFor(() => { expect(dialog()).toBeNull() })
    expect(await claimIsLive()).toBe(false)
  })

  it('spends the consent on the claim it SHOWED, not on whatever is there at the click', async () => {
    // The gap between reading "held for 3 hours" and clicking is a human pause.
    // In it the run they were told about can finish and a fresh one take the
    // workspace — and deleting that is what the warning says not to do.
    await seedClaimInBlocks({claimantId: 'a-device-that-is-gone', claimedAt: 1})
    renderGate()
    await openTheRelease()

    await deliverClaimBySync({claimantId: 'someone-else', claimedAt: 900})
    await userEvent.click(screen.getByRole('button', {name: /release the claim/i}))

    expect(await screen.findByText(/no longer the one you were shown/i)).toBeInTheDocument()
    expect(await claimIsLive()).toBe(true)
  })
})
