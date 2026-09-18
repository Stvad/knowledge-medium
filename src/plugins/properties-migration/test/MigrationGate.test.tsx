// @vitest-environment happy-dom
/**
 * The blocking dialog, driven by the synced claim.
 *
 * Against a REAL repo and the REAL sync observer rather than a stubbed hook:
 * the whole design rests on a claim written by another device reaching this one
 * and raising the dialog with nothing armed in advance, and a test that mocks
 * the subscription cannot tell whether that happens.
 */
import { Suspense, type ReactNode } from 'react'
import { vi } from 'vitest'

// The shortcut funnel injects a UI-state block into every activation, so even a
// dependency-free one reaches `useUser`. Mocked rather than provided: the
// subject here is the modal's shadowing, not who is signed in.
vi.mock('@/components/Login.tsx', () => ({useUser: () => ({id: 'user-1'})}))

/** Stands in for the dialog's own render failing — its hooks reach the shortcut
 *  funnel, which suspends on a workspace read and throws when that read fails. */
const dialogBreak = vi.hoisted(() => ({on: false}))
vi.mock('../MigrationGateDialog.tsx', async importOriginal => {
  const actual = await importOriginal<typeof import('../MigrationGateDialog.tsx')>()
  return {
    ...actual,
    MigrationGateDialog: (props: Parameters<typeof actual.MigrationGateDialog>[0]) => {
      if (dialogBreak.on) throw new Error('[test] the dialog cannot render')
      return <actual.MigrationGateDialog {...props} />
    },
  }
})
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { RepoContext } from '@/context/repo.js'
import { ActiveContextsProvider, useActiveContextsState } from '@/shortcuts/ActiveContexts'
import { ActionContextTypes } from '@/shortcuts/types'
import { defaultActionContextConfigs } from '@/shortcuts/defaultContexts'
import { actionContextsFacet } from '@/extensions/core'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { resolveFacetRuntimeSync } from '@/facets/facet'
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
import { getClientId } from '@/utils/clientId'
import { PROPERTY_CELL_BACKFILL_ID } from '@/data/internals/propertyCellBackfill'
import { MigrationGate } from '../MigrationGate.tsx'
import {
  beginLocalMigrationRun,
  __resetLocalMigrationRunForTests,
} from '../localRunMessage.ts'

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

/** The claim being RELEASED, as that reaches a peer: a tombstone by sync. */
const releaseClaimBySync = async (): Promise<void> => {
  await sharedDb.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToSyncedRowParams({
    id: CLAIM_ID, workspaceId: WS, parentId: null, orderKey: 'k-claim',
    content: PROPERTY_CELL_BACKFILL_ID, properties: claimProperties(), references: [],
    createdAt: 1, updatedAt: 9, userUpdatedAt: 9, createdBy: 'user-1', updatedBy: 'user-1',
    deleted: true,
  }))
  await sharedDb.db.execute(
    'INSERT INTO blocks_synced_changes (id, op) VALUES (?, \'upsert\')', [CLAIM_ID],
  )
  await act(async () => { await repo.startSyncObserver({throttleMs: 0}).flush() })
}

/** Reads whether the surface underneath is being shadowed — the thing that
 *  stops a bare Enter reaching the editor and splitting a block through the
 *  modal. Only `ActionContextTypes.DIALOG` does that (`resolve.ts`). */
const Shadowing = (): ReactNode => {
  const active = useActiveContextsState()
  return <div data-testid="shadowing">{String(active.has(ActionContextTypes.DIALOG))}</div>
}
const isShadowed = (): boolean => screen.getByTestId('shadowing').textContent === 'true'

/** The providers the gate sits inside in production: it is an app mount, so the
 *  shortcut runtime is always above it. Rendering it bare would let the modal
 *  lose its keyboard shadowing without a test noticing. */
const renderGate = (): void => {
  const runtime = resolveFacetRuntimeSync(
    defaultActionContextConfigs.map(context => actionContextsFacet.of(context)),
  )
  render(
    <RepoContext.Provider value={repo}>
      <AppRuntimeContextProvider value={runtime}>
        <ActiveContextsProvider>
          <Suspense fallback={null}>
            <MigrationGate />
            <Shadowing />
          </Suspense>
        </ActiveContextsProvider>
      </AppRuntimeContextProvider>
    </RepoContext.Provider>,
  )
}

const dialog = (): HTMLElement | null => screen.queryByRole('dialog')

/** The gate with a dialog that cannot render.
 *
 *  The break stays on for the whole test — the claim row loads asynchronously,
 *  so the dialog is not reached during `render()` and a flag cleared straight
 *  afterwards would leave the broken path never taken. `afterEach` clears it.
 *  The error boundary logs, so the noise is silenced rather than left looking
 *  like a real failure. */
const renderGateWithBrokenDialog = (): void => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  dialogBreak.on = true
  renderGate()
}

/** One undoable entry on the workspace, so a pause and a clear are telling
 *  apart-able. */
const recordAnUndoableEdit = (): Promise<void> =>
  repo.tx(async tx => {
    await tx.create({
      id: 'target', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'before',
    })
  }, {scope: ChangeScope.BlockDefault, description: 'seed'}).then(() => undefined)

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
  __resetLocalMigrationRunForTests()
  repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}}).repo
  repo.setActiveWorkspaceId(WS)
})
afterEach(() => {
  cleanup()
  __resetLocalMigrationRunForTests()
  dialogBreak.on = false
  vi.restoreAllMocks()
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

  it('shadows the surface underneath, so a bare key cannot write through it', async () => {
    // Radix makes the app pointer-inert and traps focus; it does NOT stop the
    // surface underneath claiming KEYS. Without the modal context, Enter still
    // matches the editor's split binding — a structural write into a graph
    // being converted, through the modal that exists to stop exactly that —
    // and its preventDefault also eats the Enter the dialog's button wanted.
    await seedClaimInBlocks()
    renderGate()
    await screen.findByRole('dialog')

    expect(isShadowed()).toBe(true)
  })

  it('cannot be dismissed', async () => {
    await seedClaimInBlocks()
    renderGate()
    await screen.findByRole('dialog')

    await userEvent.keyboard('{Escape}')

    expect(dialog()).toBeInTheDocument()
  })

  it('says what THIS device is doing, and only that a peer is converting otherwise', async () => {
    await seedClaimInBlocks({claimantId: getClientId()})
    renderGate()
    await screen.findByRole('dialog')

    act(() => {
      beginLocalMigrationRun(WS, 'Switching this workspace to property blocks…')
    })

    expect(dialog()).toHaveTextContent(/Switching this workspace to property blocks/)
    expect(dialog()).not.toHaveTextContent(/This browser is running the migration/)
  })

  it('does not report our own progress line as a PEER\'s progress', async () => {
    // The gesture publishes its first line before it takes the claim, so in
    // that window a peer's claim can be what is on screen. Reading the message
    // alone would caption someone else's run with what this device was doing.
    act(() => { beginLocalMigrationRun(WS, 'Switching this workspace to property blocks…') })
    await seedClaimInBlocks({claimantId: 'peer-device'})

    renderGate()

    expect(await screen.findByRole('dialog'))
      .toHaveTextContent(/Another device is converting this workspace/)
    expect(dialog()).not.toHaveTextContent(/Switching this workspace to property blocks/)
  })

  it('tells the running tab how to get out if it looks stuck', async () => {
    // It is not offered the release — it cannot have been stranded by a run it
    // is still executing — so without this a run whose promise never settles
    // leaves this tab behind a modal with no exit, reading copy that tells it
    // not to close.
    await seedClaimInBlocks({claimantId: getClientId()})
    renderGate()
    await screen.findByRole('dialog')

    act(() => { beginLocalMigrationRun(WS, 'Switching this workspace to property blocks…') })

    expect(dialog()).toHaveTextContent(/If this tab looks stuck, reload it/)
  })

  it('names THIS BROWSER rather than another device when the claim is our own profile', async () => {
    // `claimantId` is per browser PROFILE, so a sibling tab's live run carries
    // our id. Telling the operator's second tab that another DEVICE holds the
    // workspace sends them to release a claim their own first tab is writing
    // under.
    await seedClaimInBlocks({claimantId: getClientId()})

    renderGate()

    expect(await screen.findByRole('dialog'))
      .toHaveTextContent(/This browser is running the migration, in another tab/)
    expect(dialog()).not.toHaveTextContent(/Another device/)
  })

  it('does not report a run on a DIFFERENT workspace as this one\'s progress', async () => {
    // Two situations — a run this device started over there, and a peer's claim
    // over here — and the operator reading one as the other would be told their
    // own run is what is blocking a workspace it never touched.
    await seedClaimInBlocks()
    renderGate()
    await screen.findByRole('dialog')

    act(() => {
      beginLocalMigrationRun(OTHER_WS, 'Converting the other one…')
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

  it('survives a claim that was taken and handed back without writing anything', async () => {
    // A run refused after taking the claim — the flip declined for a non-owner,
    // synthesis throwing, the workspace switched under it — writes NOTHING and
    // releases. Charging every device its whole history for that is a cost with
    // no cause, and the gesture invites a retry, so it would be charged again.
    await recordAnUndoableEdit()
    await seedClaimInBlocks()
    renderGate()
    await screen.findByRole('dialog')

    await releaseClaimBySync()

    await waitFor(() => { expect(dialog()).toBeNull() })
    expect(repo.undoManagerFor(WS).depths(ChangeScope.BlockDefault).undo).toBe(1)
  })

  it('is refused for exactly as long as the claim is held, and no longer', async () => {
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

    // Handed back, not emptied. Emptying is the writers' call — the gesture's
    // own drop and the runner's per batch — because only they know a write
    // happened. This device may be a peer that received nothing at all.
    expect(await repo.undo()).toBe(true)
  })
})

describe('when the dialog itself cannot render', () => {
  it('still pauses undo, rather than taking the pause down with it', async () => {
    // The dialog reaches the shortcut activation funnel, which suspends on the
    // workspace's UI-state block and throws if that read fails. App mounts share
    // ONE boundary per mount, so without a boundary of its own a dialog that
    // cannot render stops the effect above it from ever committing — and the
    // migration proceeds with no modal, no undo pause, and nothing on screen to
    // say so. The pause protects rows; the dialog only talks.
    await recordAnUndoableEdit()
    await seedClaimInBlocks()

    renderGateWithBrokenDialog()

    // The dialog really did fail: nothing is on screen, and the pause is on
    // anyway. Asserting the absence alone would pass with the dialog working.
    await waitFor(() => {
      expect(repo.undoManagerFor(WS).historyDropInProgress).toBe(true)
    })
    expect(dialog()).toBeNull()
    expect(await repo.undo()).toBe(false)
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

  it('is not offered to the tab that is RUNNING the pass', async () => {
    // "Leave this tab open" and "Nothing is running?" side by side is an
    // invitation to release the claim this tab is writing under — which drops
    // the modal and the undo pause on every device while the writes continue,
    // and frees a peer to start the same uploading pass.
    await seedClaimInBlocks({claimantId: getClientId()})
    renderGate()
    await screen.findByRole('dialog')

    act(() => { beginLocalMigrationRun(WS, 'Migrating properties to blocks…') })

    expect(dialog()).toHaveTextContent(/Leave this tab open/)
    expect(screen.queryByRole('button', {name: /nothing is running/i})).toBeNull()
  })

  it('is not offered where this device may not write, which names who can', async () => {
    // The release is a BlockDefault transaction like any other, so a viewer in
    // a shared workspace could only ever produce the read-only error from it —
    // behind a modal they cannot dismiss.
    repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}, isReadOnly: true}).repo
    repo.setActiveWorkspaceId(WS)
    await seedClaimInBlocks()
    renderGate()
    await screen.findByRole('dialog')

    expect(screen.queryByRole('button', {name: /nothing is running/i})).toBeNull()
    expect(dialog()).toHaveTextContent(/read-only here, so only someone who can write/i)
  })

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
