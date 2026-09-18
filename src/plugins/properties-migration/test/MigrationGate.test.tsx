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
  opts: Parameters<typeof claimProperties>[0] & {at?: number} = {},
): Promise<void> => {
  await sharedDb.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToSyncedRowParams({
    id: CLAIM_ID, workspaceId: WS, parentId: null, orderKey: 'k-claim',
    content: PROPERTY_CELL_BACKFILL_ID, properties: claimProperties(opts), references: [],
    createdAt: 1, updatedAt: opts.at ?? 5, userUpdatedAt: opts.at ?? 5,
    createdBy: 'user-1', updatedBy: 'user-1',
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
  vi.restoreAllMocks()
})

describe('before the claim exists', () => {
  it('is already up for this device\'s own gesture, and undo with it', async () => {
    // The claim is written after several preflight reads. With nothing on
    // screen for that window the operator has just confirmed a one-way flip
    // into silence — and the pause follows the dialog, so it starts here too.
    renderGate()
    await claimHasBeenRead()

    // ASYNC act: mounting the dialog suspends on the shortcut funnel's
    // workspace read, and a synchronous act does not await that.
    await act(async () => { beginLocalMigrationRun(WS, 'Migrating properties to blocks…') })

    expect(await screen.findByRole('dialog')).toHaveTextContent(/Leave this tab open/)
    // No claim yet, so there is nothing to release — the pause is on regardless.
    expect(screen.queryByRole('button', {name: /nothing is running/i})).toBeNull()
    expect(repo.undoManagerFor(WS).historyDropInProgress).toBe(true)
  })
})

describe('while the migration holds this workspace', () => {
  it('puts the dialog up for a claim this device already has', async () => {
    // Why this matters: see MigrationGate.tsx's file header comment.
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
    // Why this matters: see graphBackfillClaim.ts's claimHoldingGraph comment.
    await seedClaimInBlocks({workspaceId: OTHER_WS})

    renderGate()

    await claimHasBeenRead()
    expect(repo.block(CLAIM_ID).peek()).toMatchObject({workspaceId: OTHER_WS})
    expect(dialog()).toBeNull()
  })

  it('shadows the surface underneath, so a bare key cannot write through it', async () => {
    // Why this matters: see useActionContext.ts's useModalShadowing comment.
    await seedClaimInBlocks()
    renderGate()
    await screen.findByRole('dialog')

    expect(isShadowed()).toBe(true)
  })

  it('keeps the writing tab\'s own line when a PEER replaces its claim', async () => {
    // Reachable from a click this dialog offers a peer: our claim is released
    // mid-run and the peer starts its own. Nothing stops our pass writing —
    // the per-batch guard checks the workspace and the view gap, never the
    // claim — so reading the row first would drop this tab's progress line and
    // hand it a button to delete that peer's live claim.
    await seedClaimInBlocks({claimantId: getClientId()})
    renderGate()
    await screen.findByRole('dialog')
    await act(async () => {
      beginLocalMigrationRun(WS, 'Converting block 120,000 of 650,000…')
    })

    await deliverClaimBySync({claimantId: 'a-peer', claimedAt: 900})

    await waitFor(() => {
      expect(repo.block(CLAIM_ID).peek()?.properties)
        .toMatchObject({[migrationClaimantProp.name]: 'a-peer'})
    })
    expect(dialog()).toHaveTextContent(/Converting block 120,000/)
    expect(screen.queryByRole('button', {name: /nothing is running/i})).toBeNull()
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

    act(() => { beginLocalMigrationRun(WS, 'Switching this workspace to property blocks…') })

    expect(dialog()).toHaveTextContent(/Switching this workspace to property blocks/)
    expect(dialog()).not.toHaveTextContent(/A migration is converting this workspace/)
  })

  it('tells the running tab how to get out if it looks stuck', async () => {
    // Why this matters: see MigrationGateDialog.tsx's this-tab reload comment.
    await seedClaimInBlocks({claimantId: getClientId()})
    renderGate()
    await screen.findByRole('dialog')

    act(() => { beginLocalMigrationRun(WS, 'Switching this workspace to property blocks…') })

    expect(dialog()).toHaveTextContent(/If it looks stuck, reload it/)
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

    expect(dialog()).toHaveTextContent(/A migration is converting this workspace/)
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
    // Why this matters: see MigrationGate.tsx's history-drop teardown comment.
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

    // Why this matters: see MigrationGate.tsx's history-drop teardown comment.
    expect(await repo.undo()).toBe(true)
  })
})

describe('when the dialog itself cannot render', () => {
  it('still pauses undo while the dialog is merely SLOW to render', async () => {
    // Why this matters: see MigrationGate.tsx's ExtensionRenderBoundary comment.
    // This is the common half: the dialog hangs rather than throwing.
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
    // Why this matters: see MigrationGate.tsx's ExtensionRenderBoundary comment.
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
    // Why this matters: see MigrationGateDialog.tsx's canRelease comment.
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
    // Why this matters: see MigrationGateDialog.tsx's "Hide this" comment.
    repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}, isReadOnly: true}).repo
    repo.setActiveWorkspaceId(WS)
    await seedClaimInBlocks()
    renderGate()
    await screen.findByRole('dialog')

    await userEvent.click(screen.getByRole('button', {name: /hide this/i}))

    await waitFor(() => { expect(dialog()).toBeNull() })
    expect(repo.undoManagerFor(WS).historyDropInProgress).toBe(true)
  })

  it('comes back when the device is granted write access after dismissing', async () => {
    // The escape exists only for a device that can do nothing about the claim.
    // A viewer promoted mid-run is the device that COULD release a stranded
    // one, so a dismissal must not outlive the state it was given for.
    repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}, isReadOnly: true}).repo
    repo.setActiveWorkspaceId(WS)
    await seedClaimInBlocks()
    renderGate()
    await screen.findByRole('dialog')
    await userEvent.click(screen.getByRole('button', {name: /hide this/i}))
    await waitFor(() => { expect(dialog()).toBeNull() })

    act(() => { repo.setReadOnly(false) })

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('button', {name: /nothing is running/i})).toBeInTheDocument()
  })

  it('does not offer that escape where the claim CAN be acted on', async () => {
    await seedClaimInBlocks()
    renderGate()
    await screen.findByRole('dialog')

    expect(screen.queryByRole('button', {name: /hide this/i})).toBeNull()
  })

  it('is not offered where this device may not write, which names who can', async () => {
    // Why this matters: see MigrationGateDialog.tsx's release prop comment.
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
    // Why this matters: see MigrationGateDialog.tsx's confirming/current comment.
    // The release itself is pinned separately in propertiesMigrationClaim.test.ts.
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
