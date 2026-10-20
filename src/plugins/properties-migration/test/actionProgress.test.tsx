// @vitest-environment happy-dom
/**
 * The palette action's PROGRESS path — what the operator sees while the pass
 * runs and what it does with the numbers afterwards. Split from
 * `action.test.ts` because pinning it means faking the pass module, and doing
 * that file-wide would make that file's "refuses before the scan" assertion
 * vacuous (the scan it must not run is a call into the same module).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PropertyCellBackfillProgress } from '@/data/internals/propertyCellBackfill'
import { WRITE_AHEAD_HEADROOM_BYTES, awaitWriteAheadHeadroom } from '@/data/writeAheadLog'

const openDialog = vi.fn(async () => true)
const progressHandle = {
  update: vi.fn(), done: vi.fn(), fail: vi.fn(), settleUnreported: vi.fn(),
  addNote: vi.fn(),
}
const showInfo = vi.fn()
const dismissToast = vi.fn()
let emit: ((progress: PropertyCellBackfillProgress) => void) | null = null

vi.mock('@/utils/dialogs.js', () => ({openDialog: () => openDialog()}))
vi.mock('@/utils/toast.js', () => ({
  showInfo: (message: string, opts?: unknown) => showInfo(message, opts),
  dismissToast: (id: string) => dismissToast(id),
}))
vi.mock('../progressReport.ts', () => ({
  reportMigrationProgress: () => progressHandle,
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
/** Everything the gesture reports and refreshes, in order. The refresh is
 *  logged when it FINISHES, a macrotask later, so one left un-awaited lands
 *  after the report. */
const steps: string[] = []
const refreshFinishing = async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  steps.push('analyze')
}
const runAnalyzeInstalledTables = vi.fn(refreshFinishing)
const oweAnalyzeInstalledTables = vi.fn(async () => { steps.push('owe') })
vi.mock('@/data/maintenance', () => ({
  oweAnalyzeInstalledTables: () => oweAnalyzeInstalledTables(),
  runAnalyzeInstalledTables: () => runAnalyzeInstalledTables(),
}))
/** The drain is the one thing in this gesture that takes the writer's lease:
 *  logged when it FINISHES, like the refresh, so one left un-awaited lands after
 *  the report. */
let drainFails = false
const writeLock = async <T,>(fn: (tx: {execute: (sql: string) => Promise<unknown>}) => Promise<T>): Promise<T> => {
  const result = await fn({execute: async () => undefined})
  await new Promise(resolve => setTimeout(resolve, 0))
  if (drainFails) throw new Error('database is locked')
  steps.push('drain')
  return result
}
/** A writer whose log is past the limit, so a headroom check pauses on it. */
const overLimitWriter = {
  execute: async (sql: string) => sql === 'PRAGMA wal_checkpoint=noop'
    ? {rows: {_array: [{n: WRITE_AHEAD_HEADROOM_BYTES}]}}
    : sql === 'PRAGMA page_size' ? {rows: {_array: [{page_size: 4096}]}} : undefined,
}
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
vi.mock('@/data/internals/propertyCellBackfill', async importOriginal => ({
  // The REAL one, not a stand-in. It is a pure sum over the progress this file
  // already emits, and a copy written here would keep these assertions green
  // with the actual function wrong — which is the whole thing they pin.
  pendingValueCount: (await importOriginal<
    typeof import('@/data/internals/propertyCellBackfill')>()).pendingValueCount,
  PROPERTY_CELL_BACKFILL_ID: 'properties:cell-to-children',
  surveyPropertyCellRejections: async () => ({keys: [], cells: 0, blocksScanned: 7}),
  flipBlockedByCellValues: () => null,
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
  blocksScanned: 7, blocksMaterialized: 7, blocksMaterializedTotal: 7,
  valuesMaterialized: 7,
  valuesMaterializedTotal: 7, sweeps: 2, failures: [], failureCount: 0,
  unresolvedNames: [], unresolvedCount: 0, ...over,
})

/** Is a claim still in flight when the gesture ends? Read from `blocks`, so the
 *  stub answers the claim query the way a live one would — and only AFTER the
 *  run, because that is when a claim this gesture did not mint appears. Answered
 *  before it too, the gesture's own entry check would see a peer's claim and
 *  decline without ever running. */
let claimHeldAfterRun: false | 'this-device' | 'a-peer' = false
let runHasHappened = false

/** Emits `reported` from inside the run, the way the pass notifies, then runs
 *  `during` while the pass is still in flight. */
const runReporting = async (
  reported: PropertyCellBackfillProgress,
  outcome: {outcome: 'ran' | 'deferred'; undoHistoryCleared: boolean; reason?: string;
            retryable?: boolean} | Error = {outcome: 'ran', undoHistoryCleared: false},
  during: () => Promise<void> | void = () => {},
) => {
  const repo = {
    activeWorkspaceId: 'ws-1',
    user: {id: 'user-1'},
    db: {
      getAll: async () => [{n: 7}],
      getOptional: async (sql: string) => {
        if (sql.includes('owner_user_id')) return {owner_user_id: 'user-1'}
        if (sql.includes('properties_json')) {
          return claimHeldAfterRun === false || !runHasHappened ? null : {
            properties_json: JSON.stringify({
              'migration:claimant': claimHeldAfterRun === 'this-device'
                ? THIS_DEVICE : 'some-other-device',
              'migration:claimed-at': 1,
            }),
          }
        }
        return {properties_migration: 'cell'}
      },
      writeLock,
    },
    isReadOnly: false,
    workspaceViewGap: async () => null,
    undoManagerFor: () => ({
      clear: () => {},
      beginHistoryDrop: () => ({finish: () => {}, abandon: () => {}}),
    }),
    withOperatorBackfillClaim: claimStub(async () => {
      steps.push('pass')
      emit?.(reported)
      await during()
      runHasHappened = true
      if (outcome instanceof Error) throw outcome
      return outcome
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
  vi.restoreAllMocks()
  progressHandle.update.mockReset()
  progressHandle.done.mockReset()
  progressHandle.fail.mockReset()
  progressHandle.settleUnreported.mockReset()
  progressHandle.addNote.mockReset()
  showInfo.mockReset()
  dismissToast.mockReset()
  emit = null
  claimHeldAfterRun = false
  runHasHappened = false
  steps.length = 0
  runAnalyzeInstalledTables.mockReset()
  runAnalyzeInstalledTables.mockImplementation(refreshFinishing)
  oweAnalyzeInstalledTables.mockReset()
  oweAnalyzeInstalledTables.mockImplementation(async () => { steps.push('owe') })
  drainFails = false
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

  it('dismisses the worklist when the run that follows has nothing to repair', async () => {
    // A stable id only covers the run that ALSO has failures. The run that
    // fixed them produces no follow-up at all, so without an explicit dismiss
    // the "N could not be migrated — repair them and run this again" toast is
    // sticky (duration Infinity) and outlives the repair, ending up beside a
    // banner that says there is nothing left to migrate.
    await runReporting(progress({failureCount: 0, failures: []}))

    expect(showInfo).not.toHaveBeenCalled()
    expect(dismissToast).toHaveBeenCalledWith('properties-migration-worklist')
  })

  it('does not dismiss the worklist it just raised', async () => {
    await runReporting(progress({failureCount: 3, failures: [{blockId: 'b1', reason: 'x'}]}))

    expect(dismissToast).not.toHaveBeenCalledWith('properties-migration-worklist')
  })

  it('keeps the worklist when the run completed but refused everything', async () => {
    // `ran`, so it completed — but it moved no value and refused N, which
    // raises no `followUp` of its own (the banner carries that count instead).
    // Those N are exactly what the standing worklist is about, so this is the
    // other ending that must not clear it.
    await runReporting(progress({
      valuesMaterialized: 0, valuesMaterializedTotal: 0,
      failureCount: 65, failures: [{blockId: 'b1', reason: 'x'}],
    }))

    expect(dismissToast).not.toHaveBeenCalledWith('properties-migration-worklist')
  })

  it('keeps the worklist when the run SKIPPED cells no schema resolves', async () => {
    // The pass excludes an unregistered key from its counters deliberately —
    // carrying it kept every sweep looking like work — so a cell skipped for
    // want of a schema raises NO failure. Read as "this run refused nothing",
    // that cleared a worklist over values nothing had ever attempted.
    await runReporting(progress({
      valuesMaterialized: 0, valuesMaterializedTotal: 0,
      failureCount: 0, failures: [],
      unresolvedCount: 12, unresolvedNames: ['a-key'],
    }))

    expect(dismissToast).not.toHaveBeenCalledWith('properties-migration-worklist')
    // And says which repair it is: registering a schema, not fixing a value.
    expect(showInfo).toHaveBeenCalledWith(
      expect.stringContaining('no registered schema'),
      expect.objectContaining({id: expect.any(String)}),
    )
  })

  it('keeps the worklist when the run did not complete', async () => {
    // A run that DEFERRED verified nothing. It produces no `followUp` either,
    // so dismissing on "no follow-up" would clear a still-actionable list of
    // what to repair on the one ending that proves least about it. Same for
    // held-by-peer, read-only, already-running and failed.
    await runReporting(progress({failureCount: 0, failures: []}),
      {outcome: 'deferred', undoHistoryCleared: false,
       reason: 'this device is not caught up', retryable: true})

    expect(dismissToast).not.toHaveBeenCalledWith('properties-migration-worklist')
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
    // release would delete a claim that device is still writing under.
    claimHeldAfterRun = 'a-peer'

    await runReporting(progress())

    const note = progressHandle.addNote.mock.calls[0]?.[0] as string | undefined
    expect(note).toContain('another device holds the migration')
    // The discriminator: the self branch's sentence must not be here, or the
    // device is told to re-run something it will be declined for every time.
    expect(note).not.toContain('this device holds the migration')
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

  it('reports the blocks the RUN changed, not the ones the sweep accepted', async () => {
    // The two counters answer different questions and only diverge on a real
    // graph: `blocksMaterialized` is every owner the last sweep found
    // acceptable — its whole scan, once converged — while
    // `blocksMaterializedTotal` is the distinct owners the run actually
    // changed. Reading the first told the operator a re-run had migrated
    // every block it had merely re-checked.
    //
    // Pinned HERE because it is a wiring choice: `describeOutcome` is handed
    // one number and cannot tell which it was given, so no test of that
    // function can catch the swap.
    await runReporting(progress({
      blocksScanned: 900, blocksMaterialized: 900, blocksMaterializedTotal: 12,
      valuesMaterialized: 0, valuesMaterializedTotal: 34,
    }))

    expect(progressHandle.done).toHaveBeenCalledWith(expect.stringMatching(/on 12 blocks/))
    expect(progressHandle.done).toHaveBeenCalledWith(expect.not.stringMatching(/900/))
  })
})

describe('planner stats and the write-ahead log after the pass', () => {
  beforeEach(() => {
    progressHandle.done.mockImplementation(() => { steps.push('done') })
    progressHandle.fail.mockImplementation(() => { steps.push('fail') })
  })

  it('records the refresh as owed before the pass, and refreshes, then drains, before reporting', async () => {
    // Owed first, so a reload, a dead tab or a failed refresh leaves it for
    // the next boot's check; refreshed before the report, so plans are good now.
    // Drained after the refresh, which writes too, and before the report, which
    // is what tells the operator a reload is safe.
    await runReporting(progress())

    expect(steps).toEqual(['owe', 'pass', 'analyze', 'drain', 'done'])
  })

  it('refreshes them after a run that wrote nothing, which may finish one that died first', async () => {
    await runReporting(progress({
      blocksMaterialized: 0, blocksMaterializedTotal: 0,
      valuesMaterialized: 0, valuesMaterializedTotal: 0,
    }))

    expect(steps).toEqual(['owe', 'pass', 'analyze', 'drain', 'done'])
  })

  it('refreshes and drains when the pass throws partway, before reporting the failure', async () => {
    await runReporting(progress(), new Error('claim write failed'))

    expect(steps).toEqual(['owe', 'pass', 'analyze', 'drain', 'fail'])
  })

  it('keeps the run\'s outcome when the refresh itself fails, leaving it owed', async () => {
    runAnalyzeInstalledTables.mockRejectedValue(new Error('database is locked'))

    await runReporting(progress())

    expect(progressHandle.done).toHaveBeenCalled()
    expect(progressHandle.fail).not.toHaveBeenCalled()
  })

  it('still runs the pass when the debt cannot be recorded', async () => {
    oweAnalyzeInstalledTables.mockRejectedValue(new Error('disk I/O error'))

    await runReporting(progress())

    expect(steps).toEqual(['pass', 'analyze', 'drain', 'done'])
  })

  it('keeps the run\'s outcome when the drain fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    drainFails = true

    await runReporting(progress())

    expect(progressHandle.done).toHaveBeenCalled()
    expect(progressHandle.fail).not.toHaveBeenCalled()
  })
})

describe('a pause for the write-ahead log', () => {
  it('says why the migration stopped, and goes back to its count when it resumes', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    await runReporting(progress({sweeps: 1, blocksScanned: 3}), undefined,
      () => awaitWriteAheadHeadroom(overLimitWriter))

    const lines = progressHandle.update.mock.calls.map(([line]) => line as string)
    const counting = lines.findIndex(line => /sweep 1, 3\//.test(line))
    expect(lines.slice(counting, counting + 3)).toEqual([
      lines[counting],
      expect.stringMatching(/paused.*\d+ MB/i),
      lines[counting],
    ])
  })

  it('listens only while the gesture runs', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    await runReporting(progress())
    const reported = progressHandle.update.mock.calls.length

    await awaitWriteAheadHeadroom(overLimitWriter)

    expect(progressHandle.update.mock.calls.length).toBe(reported)
  })
})
