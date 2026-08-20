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
const progressHandle = {update: vi.fn(), done: vi.fn(), fail: vi.fn()}
const showInfo = vi.fn()
let emit: ((progress: PropertyCellBackfillProgress) => void) | null = null

vi.mock('@/utils/dialogs.js', () => ({openDialog: () => openDialog()}))
vi.mock('@/utils/toast.js', () => ({
  showProgress: () => progressHandle,
  showInfo: (message: string, opts?: unknown) => showInfo(message, opts),
}))
vi.mock('../ConfirmMigrationDialog.tsx', () => ({ConfirmMigrationDialog: () => null}))
vi.mock('@/data/internals/propertyCellBackfill', () => ({
  PROPERTY_CELL_BACKFILL_ID: 'properties:cell-to-children',
  countPropertyCellBackfillCandidates: async () => 7,
  onPropertyCellBackfillProgress: (listener: (p: PropertyCellBackfillProgress) => void) => {
    emit = listener
    return () => { emit = null }
  },
}))

import type { Repo } from '@/data/repo'
import { migratePropertiesToBlocksAction } from '../action.ts'

const progress = (over: Partial<PropertyCellBackfillProgress> = {}): PropertyCellBackfillProgress => ({
  blocksScanned: 7, blocksMaterialized: 7, valuesMaterialized: 7, sweeps: 2,
  orphanedOwnersSwept: 0, failures: [], failureCount: 0, editedUnderPass: false, ...over,
})

/** Emits `reported` from inside the run, the way the pass notifies. */
const runReporting = async (reported: PropertyCellBackfillProgress) => {
  const repo = {
    activeWorkspaceId: 'ws-1',
    db: {getAll: async () => [{n: 7}], getOptional: async () => ({properties_migration: 'cell'})},
    runWorkspaceBackfillNow: async () => {
      emit?.(reported)
      return {outcome: 'ran' as const, undoHistoryCleared: false}
    },
  } as unknown as Repo
  await migratePropertiesToBlocksAction({repo}).handler({} as never, {} as never)
}

afterEach(() => {
  progressHandle.update.mockReset()
  progressHandle.done.mockReset()
  progressHandle.fail.mockReset()
  showInfo.mockReset()
  emit = null
})

describe('the migration progress path', () => {
  it('carries "the workspace was edited under the pass" through to the operator', async () => {
    // The flag is the ONLY thing telling an operator the children may already
    // be behind the cells — convergence deliberately does not loop on it. It
    // reaches the banner only if the action reads it off the progress it is
    // handed, which nothing else in the suite exercises.
    await runReporting(progress({editedUnderPass: true}))

    expect(progressHandle.done).toHaveBeenCalledWith(
      expect.stringMatching(/may already be behind/i))
  })

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

  it('shows the sweep number, so a second pass does not look like a restart', async () => {
    await runReporting(progress({sweeps: 2, blocksScanned: 3}))

    expect(progressHandle.update).toHaveBeenCalledWith(expect.stringMatching(/sweep 2/i))
  })
})
