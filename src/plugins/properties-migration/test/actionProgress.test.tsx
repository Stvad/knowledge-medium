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
  dismissToast: vi.fn(),
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
import { migratePropertiesToBlocksAction } from '../action.ts'

const progress = (over: Partial<PropertyCellBackfillProgress> = {}): PropertyCellBackfillProgress => ({
  blocksScanned: 7, blocksMaterialized: 7, valuesMaterialized: 7,
  valuesMaterializedTotal: 7, sweeps: 2, failures: [], failureCount: 0, ...over,
})

/** Emits `reported` from inside the run, the way the pass notifies. */
const runReporting = async (reported: PropertyCellBackfillProgress) => {
  const repo = {
    activeWorkspaceId: 'ws-1',
    user: {id: 'user-1'},
    db: {
      getAll: async () => [{n: 7}],
      getOptional: async (sql: string) => sql.includes('owner_user_id')
        ? {owner_user_id: 'user-1'}
        : {properties_migration: 'cell'},
    },
    isReadOnly: false,
    workspaceViewGap: async () => null,
    undoManagerFor: () => ({clear: () => {}}),
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
