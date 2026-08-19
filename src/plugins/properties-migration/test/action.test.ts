// @vitest-environment happy-dom
/**
 * The palette entry for the one-time properties migration. What matters here
 * is the gesture's guard and what the user is told afterwards — the pass
 * itself is covered in `propertyCellBackfill.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const openDialog = vi.fn()
const progressHandle = {update: vi.fn(), done: vi.fn(), fail: vi.fn()}

vi.mock('@/utils/dialogs.js', () => ({openDialog: (...args: unknown[]) => openDialog(...args)}))
const showInfo = vi.fn()
vi.mock('@/utils/toast.js', () => ({
  showProgress: () => progressHandle,
  showInfo: (...args: unknown[]) => showInfo(...args),
}))
vi.mock('../ConfirmMigrationDialog.tsx', () => ({ConfirmMigrationDialog: () => null}))

import type { OperatorBackfillResult, Repo } from '@/data/repo'
import { describeOutcome, migratePropertiesToBlocksAction } from '../action.ts'

const makeRepo = (result: OperatorBackfillResult, {flipped = false} = {}) => {
  const runWorkspaceBackfillNow = vi.fn(async () => result)
  const getAll = vi.fn(async () => [{n: 7}])
  const repo = {
    activeWorkspaceId: 'ws-1',
    db: {
      getAll,
      getOptional: async () => ({properties_migration: flipped ? 'children' : 'cell'}),
    },
    runWorkspaceBackfillNow,
  } as unknown as Repo
  return {repo, runWorkspaceBackfillNow, getAll}
}

/** The dialog is a user-length pause; this is the seam for what happens during
 *  it. */
const dialogThatSwitchesWorkspace = (repo: Repo) => async () => {
  ;(repo as unknown as {activeWorkspaceId: string}).activeWorkspaceId = 'ws-2'
  return true
}

const invoke = (repo: Repo) =>
  migratePropertiesToBlocksAction({repo}).handler({} as never, {} as never)

afterEach(() => {
  openDialog.mockReset()
  showInfo.mockReset()
  progressHandle.update.mockReset()
  progressHandle.done.mockReset()
  progressHandle.fail.mockReset()
})

describe('migrate_properties_to_blocks action', () => {
  it('writes nothing when the user cancels the confirmation', async () => {
    // The confirmation is the whole guard on a pass that uploads hundreds of
    // thousands of rows and drops the workspace's undo history.
    openDialog.mockResolvedValue(null)
    const {repo, runWorkspaceBackfillNow} = makeRepo(
      {outcome: 'ran', undoHistoryCleared: true},
    )

    await invoke(repo)

    expect(runWorkspaceBackfillNow).not.toHaveBeenCalled()
  })

  it('refuses a flipped workspace before the scan and the confirmation', async () => {
    // Past the flip the pass can never run. Reaching the first batch
    // transaction to find that out spends a full workspace scan and a
    // user-length pause, and reports an internal error that says to try again.
    openDialog.mockResolvedValue(true)
    const {repo, runWorkspaceBackfillNow, getAll} = makeRepo(
      {outcome: 'ran', undoHistoryCleared: false}, {flipped: true},
    )

    await invoke(repo)

    // Before the SCAN as well as before the dialog: counting candidates is an
    // unbounded json_each walk of the workspace on the UI thread.
    expect(getAll).not.toHaveBeenCalled()
    expect(openDialog).not.toHaveBeenCalled()
    expect(runWorkspaceBackfillNow).not.toHaveBeenCalled()
  })

  it('does not run against a workspace the user left while confirming', async () => {
    // The runner's own active-workspace check runs only AFTER `tryClaim` has
    // written a Migrations page and a claim row, so a stale pin means two
    // blocks land in a graph the user never meant to touch.
    const {repo, runWorkspaceBackfillNow} = makeRepo({outcome: 'ran', undoHistoryCleared: true})
    openDialog.mockImplementation(dialogThatSwitchesWorkspace(repo))

    await invoke(repo)

    expect(runWorkspaceBackfillNow).not.toHaveBeenCalled()
  })

  it('tells the user their undo history went with it', async () => {
    openDialog.mockResolvedValue(true)
    const {repo} = makeRepo({outcome: 'ran', undoHistoryCleared: true})

    await invoke(repo)

    expect(progressHandle.done).toHaveBeenCalledWith(expect.stringMatching(/undo history/i))
  })

  it('reports a deferred pass as unfinished rather than as done', async () => {
    // `deferred` means a precondition that clears on its own. Reporting it
    // through `done` would read as "migration complete" to the one person who
    // needs to come back and re-run it.
    openDialog.mockResolvedValue(true)
    const {repo} = makeRepo({
      outcome: 'deferred',
      undoHistoryCleared: false,
      reason: 'this device is not caught up with the server',
    })

    await invoke(repo)

    expect(progressHandle.done).not.toHaveBeenCalled()
    expect(progressHandle.fail).toHaveBeenCalledWith(expect.stringMatching(/not caught up/))
  })
})

describe('what a completed run tells the operator', () => {
  const ran = {outcome: 'ran', undoHistoryCleared: false} as const
  const counts = (blocks: number) =>
    ({blocksMaterialized: blocks, valuesMaterialized: blocks, unmigrated: 0, orphanedOwnersSwept: 0})

  it('calls a run that migrated nothing a failure, not a green "0 blocks"', async () => {
    // Failures are per-value by design, so a systematic problem — a codec
    // rejecting everything, storage refusing writes — otherwise came back as
    // a success banner reading "Migrated properties on 0 blocks."
    const {message, failed} = describeOutcome(ran, {blocksMaterialized: 0, valuesMaterialized: 0, unmigrated: 12, orphanedOwnersSwept: 0}, false)

    expect(failed).toBe(true)
    expect(message).toMatch(/systematic/i)
  })

  it('reports what it DELETED, which nothing else does', async () => {
    // The sweep that removes stale children is by construction never the one
    // that converges, and every other count is per-sweep — so a run whose only
    // effect was deletion otherwise reads "Migrated properties on 0 blocks."
    const {message} = describeOutcome(
      ran,
      {blocksMaterialized: 0, valuesMaterialized: 0, unmigrated: 0, orphanedOwnersSwept: 4},
      false,
    )

    expect(message).toMatch(/removed the property children of 4/i)
  })

  it('is not "systematic" when one bad key per block hid a mostly-good run', async () => {
    // `blocksMaterialized` counts blocks accepted in FULL, so it reads zero for
    // a run that wrote every other key on every block. Branching on it told the
    // operator nothing was migrated while tens of thousands of rows were.
    const {failed} = describeOutcome(
      ran, {blocksMaterialized: 0, valuesMaterialized: 40, unmigrated: 20, orphanedOwnersSwept: 0}, false,
    )

    expect(failed).toBe(false)
  })

  it('says to run again when the workspace was edited under the pass', async () => {
    // Convergence deliberately does not loop on rewritten values, so this
    // sentence is the only thing that tells an operator the children it just
    // built may already be behind the cells.
    expect(describeOutcome(ran, counts(100), true).message).toMatch(/run this again before flipping/i)
    expect(describeOutcome(ran, counts(100), false).message).not.toMatch(/run this again/i)
  })
})

describe('what an aborted run tells the operator', () => {
  const counts = (blocks: number) =>
    ({blocksMaterialized: blocks, valuesMaterialized: blocks, unmigrated: 0, orphanedOwnersSwept: 0})

  it('does not say "Not started" for a run that wrote and dropped the undo stack', async () => {
    // The per-transaction preconditions abort MID-run, and on a connected
    // device that is the expected ending — after a large part of the graph is
    // already written.
    const {message} = describeOutcome(
      {outcome: 'deferred', undoHistoryCleared: true, reason: 'synced rows are still draining'},
      counts(0), false,
    )

    expect(message).not.toMatch(/not started/i)
    expect(message).toMatch(/undo history/i)
  })

  it('tells a failed run its undo history is gone too', async () => {
    const {message} = describeOutcome(
      {outcome: 'failed', undoHistoryCleared: true, reason: 'the pass gave up.'}, counts(0), false,
    )

    expect(message).toMatch(/undo history/i)
  })
})
