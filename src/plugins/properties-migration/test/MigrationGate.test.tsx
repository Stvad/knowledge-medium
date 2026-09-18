// @vitest-environment happy-dom
/**
 * The blocking dialog, driven by the synced claim.
 *
 * Against a REAL repo and the REAL sync observer rather than a stubbed hook:
 * the whole design rests on a claim written by another device reaching this one
 * and raising the dialog with nothing armed in advance, and a test that mocks
 * the subscription cannot tell whether that happens.
 */
import { Suspense, use, type ReactNode } from 'react'

/** A promise that never settles, for the suspend-forever case. */
const NEVER = new Promise<never>(() => {})
import { vi } from 'vitest'

// The shortcut funnel injects a UI-state block into every activation, so even a
// dependency-free one reaches `useUser`. Mocked rather than provided: the
// subject here is the modal's shadowing, not who is signed in.
vi.mock('@/components/Login.tsx', () => ({useUser: () => ({id: 'user-1'})}))

const shownToasts = vi.hoisted(() => [] as string[])
vi.mock('@/utils/toast.js', async importOriginal => ({
  ...await importOriginal<typeof import('@/utils/toast.js')>(),
  showInfo: (message: string) => { shownToasts.push(message) },
}))

/** Stands in for the dialog's own render failing — its hooks reach the shortcut
 *  funnel, which suspends on a workspace read and throws when that read fails. */
const dialogBreak = vi.hoisted(() => ({on: false, hang: false}))
vi.mock('../MigrationGateDialog.tsx', async importOriginal => {
  const actual = await importOriginal<typeof import('../MigrationGateDialog.tsx')>()
  return {
    ...actual,
    MigrationGateDialog: (props: Parameters<typeof actual.MigrationGateDialog>[0]) => {
      if (dialogBreak.on) throw new Error('[test] the dialog cannot render')
      // Suspends and never settles, which is the SHAPE of the dialog's real
      // first render: its shortcut activation reaches a workspace read through
      // `use()`. That happens on every run, unlike the throw.
      if (dialogBreak.hang) use(NEVER)
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
  markLocalMigrationRunClaimed,
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
  dialogBreak.hang = false
  shownToasts.length = 0
  vi.restoreAllMocks()
})

describe('before the claim exists', () => {
  it('is already up for this device\'s own gesture', async () => {
    // The claim is written after several preflight reads and a page-ensure.
    // Without this the operator confirms a one-way fleet-wide flip and the app
    // goes back to normal for a few seconds — master showed a progress toast
    // here, and the split that moved progress into the dialog dropped it.
    renderGate()
    await claimHasBeenRead()

    // ASYNC act: mounting the dialog suspends on the shortcut funnel's
    // workspace read, and a synchronous act does not await that.
    await act(async () => { beginLocalMigrationRun(WS, 'Migrating properties to blocks…') })

    expect(await screen.findByRole('dialog'))
      .toHaveTextContent(/Nothing has been written yet/)
    // No claim yet, so nothing is owed a release and nothing is paused.
    expect(screen.queryByRole('button', {name: /nothing is running/i})).toBeNull()
    expect(repo.undoManagerFor(WS).historyDropInProgress).toBe(false)
  })
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

  it('tells a tab that LOST the claim, rather than that nothing has been written', async () => {
    // "No claim" is true at both ends of a run. The release this dialog itself
    // offers can take the claim from under a tab that is still writing, and
    // that tab must not then read "Nothing has been written yet" — it is the
    // one tab whose closing costs something, and the copy it would lose is
    // "Leave this tab open."
    await seedClaimInBlocks({claimantId: getClientId()})
    renderGate()
    await screen.findByRole('dialog')
    await act(async () => {
      const owner = beginLocalMigrationRun(WS, 'Converting block 120,000 of 650,000…')
      markLocalMigrationRunClaimed(owner, WS)
    })
    expect(dialog()).toHaveTextContent(/Leave this tab open/)

    await releaseClaimBySync()

    await waitFor(() => {
      expect(dialog()).toHaveTextContent(/This tab no longer holds the migration/)
    })
    expect(dialog()).toHaveTextContent(/Converting block 120,000/)
    expect(dialog()).not.toHaveTextContent(/Nothing has been written yet/)
  })

  it('offers no close button — dismissing is not how this one ends', async () => {
    await seedClaimInBlocks()
    renderGate()
    await screen.findByRole('dialog')

    expect(screen.queryByRole('button', {name: /^close$/i})).toBeNull()
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
    renderGate()
    await claimHasBeenRead()
    await act(async () => {
      beginLocalMigrationRun(WS, 'Switching this workspace to property blocks…')
    })

    // The real sequence: our gesture publishes its first line, then a PEER's
    // claim is what lands. The line is ours; the run is not.
    await deliverClaimBySync({claimantId: 'peer-device'})

    await waitFor(() => {
      expect(dialog()).toHaveTextContent(/Another device is converting this workspace/)
    })
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
      .toHaveTextContent(/This browser profile holds the migration/)
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
  it('still pauses undo while the dialog is merely SLOW to render', async () => {
    // The common half, and the one the boundary's `Suspense` covers: the
    // dialog's first render suspends on a workspace read every single run.
    // Without an inner boundary that propagates to the shared app-mount one, so
    // the effect holding the pause is never committed — and the pause is late
    // by the whole length of that read, on the ordinary path rather than a
    // rare one.
    await recordAnUndoableEdit()
    await seedClaimInBlocks()
    dialogBreak.hang = true

    renderGate()

    await waitFor(() => {
      expect(repo.undoManagerFor(WS).historyDropInProgress).toBe(true)
    })
    expect(dialog()).toBeNull()
    expect(await repo.undo()).toBe(false)
  })

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

describe('after a run that finished', () => {
  it('leaves the peer something telling it to reload, since the dialog goes', async () => {
    // The peer keeps pre-migration entries the run has made stale, and the
    // dialog — its only instruction — unmounts at exactly the moment reloading
    // starts to matter. In a shared workspace this user never saw the
    // operator's confirmation either.
    await recordAnUndoableEdit()
    await seedClaimInBlocks()
    renderGate()
    await screen.findByRole('dialog')

    await deliverClaimBySync({completed: true})

    await waitFor(() => { expect(dialog()).toBeNull() })
    expect(shownToasts.join(' ')).toMatch(/Reload this tab before using undo/)
  })

  it('says nothing to a device with no entries left to replay', async () => {
    // The tab that ran the pass cleared its own stack as it committed, and its
    // outcome toast already says so — a second infinite toast telling it to
    // reload before using undo would contradict the first.
    await seedClaimInBlocks()
    renderGate()
    await screen.findByRole('dialog')
    expect(repo.undoManagerFor(WS).depths(ChangeScope.BlockDefault).undo).toBe(0)

    await deliverClaimBySync({completed: true})

    await waitFor(() => { expect(dialog()).toBeNull() })
    expect(shownToasts).toEqual([])
  })

  it('says nothing when the claim was merely handed back', async () => {
    await recordAnUndoableEdit()
    // A release, or a run that refused before writing, owes the user nothing —
    // and a reload notice after a migration that never happened is noise that
    // teaches them to ignore the next one.
    await seedClaimInBlocks()
    renderGate()
    await screen.findByRole('dialog')

    await releaseClaimBySync()

    await waitFor(() => { expect(dialog()).toBeNull() })
    expect(shownToasts).toEqual([])
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

  it('goes away when this device is demoted mid-run', async () => {
    // A membership row that has not synced reads as writable, and the next
    // sync tick flips it — so a viewer can be looking at the release button
    // when the demotion lands. Reading `isReadOnly` without subscribing left it
    // there for the life of the dialog, producing the raw read-only error
    // inside a modal that cannot be dismissed.
    await seedClaimInBlocks()
    renderGate()
    await screen.findByRole('dialog')
    expect(screen.getByRole('button', {name: /nothing is running/i})).toBeInTheDocument()

    act(() => { repo.setReadOnly(true) })

    await waitFor(() => {
      expect(screen.queryByRole('button', {name: /nothing is running/i})).toBeNull()
    })
    expect(dialog()).toHaveTextContent(/read-only here, so only someone who can write/i)
  })

  it('lets a device that can do NOTHING about the claim out of the modal', async () => {
    // The gate mount is `essential`, so safe mode and the settings toggle are
    // no longer escapes. A viewer whose owner stranded a claim would otherwise
    // be behind a non-dismissible modal with no button, on every reload,
    // forever. Hiding it drops only the DIALOG — the undo pause lives above and
    // keeps running, which is the half that protects rows.
    repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}, isReadOnly: true}).repo
    repo.setActiveWorkspaceId(WS)
    await seedClaimInBlocks()
    renderGate()
    await screen.findByRole('dialog')

    await userEvent.click(screen.getByRole('button', {name: /hide this/i}))

    await waitFor(() => { expect(dialog()).toBeNull() })
    expect(repo.undoManagerFor(WS).historyDropInProgress).toBe(true)
  })

  it('does not offer that escape where the claim CAN be acted on', async () => {
    await seedClaimInBlocks()
    renderGate()
    await screen.findByRole('dialog')

    expect(screen.queryByRole('button', {name: /hide this/i})).toBeNull()
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

  it('withdraws the consent panel when the claim under it is replaced', async () => {
    // The gap between reading "held at least 3 hour(s) ago" and clicking is a
    // human pause, and in it the run they were told about can finish and a fresh
    // one take the workspace. The age on screen would then be an argument for
    // releasing a claim that is seconds old. The panel stops being current
    // instead — and the release ITSELF still refuses a claim it was not given
    // consent for, pinned directly in `propertiesMigrationClaim.test.ts`.
    await seedClaimInBlocks({claimantId: 'a-device-that-is-gone', claimedAt: 1})
    renderGate()
    await openTheRelease()
    expect(screen.getByRole('button', {name: /release the claim/i})).toBeInTheDocument()

    await deliverClaimBySync({claimantId: 'someone-else', claimedAt: 900})

    await waitFor(() => {
      expect(screen.queryByRole('button', {name: /release the claim/i})).toBeNull()
    })
    expect(screen.getByRole('button', {name: /nothing is running/i})).toBeInTheDocument()
    expect(await claimIsLive()).toBe(true)
  })
})
