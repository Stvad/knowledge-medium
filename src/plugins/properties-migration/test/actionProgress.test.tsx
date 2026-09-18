// @vitest-environment happy-dom
/**
 * The palette action's PROGRESS path — what the operator sees while the pass
 * runs and what it does with the numbers afterwards. Split from
 * `action.test.ts` because pinning it means faking the pass module, and doing
 * that file-wide would make that file's "refuses before the scan" assertion
 * vacuous (the scan it must not run is a call into the same module).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PropertyCellBackfillProgress } from '@/data/internals/propertyCellBackfill'

const openDialog = vi.fn(async () => true)
const progressHandle = {
  update: vi.fn(), done: vi.fn(), fail: vi.fn(), settleUnreported: vi.fn(),
  addNote: vi.fn(),
}
const showInfo = vi.fn()
let emit: ((progress: PropertyCellBackfillProgress) => void) | null = null

vi.mock('@/utils/dialogs.js', () => ({openDialog: () => openDialog()}))
vi.mock('@/utils/toast.js', () => ({
  showInfo: (message: string, opts?: unknown) => showInfo(message, opts),
  dismissToast: vi.fn(),
}))
vi.mock('../blockingProgress.ts', () => ({
  showBlockingMigrationProgress: () => progressHandle,
}))
vi.mock('../ConfirmMigrationDialog.tsx', () => ({ConfirmMigrationDialog: () => null}))
// The gesture flips before it backfills, and the fixture below starts at
// 'cell'. Faked here rather than pre-flipping the fixture, because a
// pre-flipped workspace takes the create-only path and this file is about what
// the operator sees during the FULL pass.
vi.mock('@/data/workspaces', () => ({
  flipWorkspaceToChildBackedProperties: async () => ({localApplied: true}),
}))
vi.mock('@/data/repoProvider', () => ({isRemoteSyncActive: () => true}))
// The synthesis half has its own file; here it must simply not refuse, so the
// gesture reaches the pass.
vi.mock('@/data/internals/propertyDefinitionSynthesis', () => ({
  planPropertyDefinitionSynthesis: async () => ({
    workspaceId: 'ws-1', refusal: null, syncGap: null,
    candidates: [], blockers: [], brokenDefinitions: [],
  }),
  applyPropertyDefinitionSynthesis: async () => ({created: 0, restored: 0, skipped: []}),
  flipBlockedBySynthesis: () => null,
}))
vi.mock('@/data/internals/propertyCellBackfill', () => ({
  PROPERTY_CELL_BACKFILL_ID: 'properties:cell-to-children',
  countPropertyCellBackfillCandidates: async () => 7,
  onPropertyCellBackfillProgress: (listener: (p: PropertyCellBackfillProgress) => void) => {
    emit = listener
    return () => { emit = null }
  },
}))

import type { Repo } from '@/data/repo'
import { getClientId } from '@/utils/clientId'
import { claimStub } from './claimStub.ts'
import { migratePropertiesToBlocksAction } from '../action.ts'

const THIS_DEVICE = getClientId()

const progress = (over: Partial<PropertyCellBackfillProgress> = {}): PropertyCellBackfillProgress => ({
  blocksScanned: 7, blocksMaterialized: 7, valuesMaterialized: 7,
  valuesMaterializedTotal: 7, sweeps: 2, failures: [], failureCount: 0, ...over,
})

/** Is a claim still in flight when the gesture ends? Read from `blocks`, so the
 *  stub answers the claim query the way a live one would. */
let claimHeldAfterRun: false | 'this-device' | 'a-peer' = false

/** Emits `reported` from inside the run, the way the pass notifies. */
const runReporting = async (reported: PropertyCellBackfillProgress) => {
  const repo = {
    activeWorkspaceId: 'ws-1',
    user: {id: 'user-1'},
    db: {
      getAll: async () => [{n: 7}],
      getOptional: async (sql: string) => {
        if (sql.includes('owner_user_id')) return {owner_user_id: 'user-1'}
        if (sql.includes('properties_json')) {
          return claimHeldAfterRun === false ? null : {
            properties_json: JSON.stringify({
              'migration:claimant': claimHeldAfterRun === 'this-device'
                ? THIS_DEVICE : 'some-other-device',
              'migration:claimed-at': 1,
            }),
          }
        }
        return {properties_migration: 'cell'}
      },
    },
    isReadOnly: false,
    workspaceViewGap: async () => null,
    undoManagerFor: () => ({
      clear: () => {},
      beginHistoryDrop: () => ({finish: () => {}, abandon: () => {}}),
    }),
    withOperatorBackfillClaim: claimStub(async () => {
      emit?.(reported)
      return {outcome: 'ran' as const, undoHistoryCleared: false}
    }),
  } as unknown as Repo
  await migratePropertiesToBlocksAction({repo}).handler({} as never, {} as never)
}

/** A gesture whose claimed region throws, rather than returning an outcome. */
const runThrowing = async (error: Error) => {
  const repo = {
    activeWorkspaceId: 'ws-1',
    user: {id: 'user-1'},
    db: {
      getAll: async () => [{n: 7}],
      getOptional: async (sql: string) => {
        if (sql.includes('owner_user_id')) return {owner_user_id: 'user-1'}
        if (sql.includes('properties_json')) return null
        return {properties_migration: 'cell'}
      },
    },
    isReadOnly: false,
    workspaceViewGap: async () => null,
    undoManagerFor: () => ({
      clear: () => {},
      beginHistoryDrop: () => ({finish: () => {}, abandon: () => {}}),
    }),
    withOperatorBackfillClaim: () => Promise.reject(error),
  } as unknown as Repo
  return migratePropertiesToBlocksAction({repo}).handler({} as never, {} as never)
}

afterEach(() => {
  progressHandle.update.mockReset()
  progressHandle.done.mockReset()
  progressHandle.fail.mockReset()
  progressHandle.settleUnreported.mockReset()
  progressHandle.addNote.mockReset()
  showInfo.mockReset()
  emit = null
  claimHeldAfterRun = false
})

describe('the migration progress path', () => {
  it('gives the repair worklist a stable toast id, so a re-run replaces it', async () => {
    // The worklist itself says to run this again; without an id the next run
    // stacks a second sticky toast beside the first, identical apart from a
    // count that is now wrong.
    await runReporting(progress({failureCount: 3, failures: [{blockId: 'b1', reason: 'x'}]}))

    expect(showInfo).toHaveBeenCalledWith(
      expect.stringContaining('3'),
      expect.objectContaining({id: expect.any(String)}),
    )
  })

  it('says the workspace is still locked when THIS device ends still holding it', async () => {
    // The outcome messages are written before it is known whether the graph was
    // handed back, and an interrupted or INHERITED run never releases it. "Run
    // it again" over a workspace that is silently refusing every edit is the
    // wrong thing to be told.
    claimHeldAfterRun = 'this-device'

    await runReporting(progress())

    expect(progressHandle.addNote).toHaveBeenCalledWith(
      expect.stringContaining('this device holds the migration'),
    )
  })

  it('does not tell a device to re-run a migration a PEER holds', async () => {
    // Running again here is declined every time while a peer holds it, and the
    // release command would delete a claim that device is still writing under.
    claimHeldAfterRun = 'a-peer'

    await runReporting(progress())

    const note = progressHandle.addNote.mock.calls[0]?.[0] as string | undefined
    expect(note).toContain('another device holds the migration')
    expect(note).not.toContain('Run this again here')
  })

  it('leaves the modal closable when the gesture throws', async () => {
    // The modal has no close button while it reads as running, so a throw that
    // escapes without reporting an outcome leaves the tab needing a reload.
    // This is the only thing standing between that and the user.
    await expect(runThrowing(new Error('claim write blew up'))).rejects.toThrow()

    expect(progressHandle.settleUnreported).toHaveBeenCalled()
  })

  it('says nothing about a lock when the run handed the workspace back', async () => {
    await runReporting(progress())

    expect(progressHandle.addNote).not.toHaveBeenCalled()
  })

  it('shows the sweep number, so a second pass does not look like a restart', async () => {
    await runReporting(progress({sweeps: 2, blocksScanned: 3}))

    expect(progressHandle.update).toHaveBeenCalledWith(expect.stringMatching(/sweep 2/i))
  })
})
