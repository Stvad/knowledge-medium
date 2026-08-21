// @vitest-environment happy-dom
/**
 * The palette entry for the one-time properties migration. What matters here
 * is the gesture's guard and what the user is told afterwards — the pass
 * itself is covered in `propertyCellBackfill.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const openDialog = vi.fn()
const progressHandle = {update: vi.fn(), done: vi.fn(), fail: vi.fn()}

vi.mock('@/utils/dialogs.js', () => ({openDialog: (...args: unknown[]) => openDialog(...args)}))
const showInfo = vi.fn()
vi.mock('@/utils/toast.js', () => ({
  showProgress: () => progressHandle,
  showInfo: (...args: unknown[]) => showInfo(...args),
}))
vi.mock('../ConfirmMigrationDialog.tsx', () => ({ConfirmMigrationDialog: () => null}))
const flipWorkspace = vi.fn<(repo: unknown, workspaceId: string) => Promise<{localApplied: boolean}>>()
vi.mock('@/data/workspaces', () => ({
  flipWorkspaceToChildBackedProperties: (repo: unknown, workspaceId: string) =>
    flipWorkspace(repo, workspaceId),
}))
const remoteSyncActive = vi.fn<() => boolean>()
vi.mock('@/data/repoProvider', () => ({isRemoteSyncActive: () => remoteSyncActive()}))
// §9 synthesis. Faked here so this file stays about the gesture's ORDER —
// what the plan says, and what the gesture does about it. What the plan means
// is `propertyDefinitionSynthesis.test.ts`.
const planSynthesis = vi.fn()
const applySynthesis = vi.fn()
const flipBlocked = vi.fn<() => string | null>()
vi.mock('@/data/internals/propertyDefinitionSynthesis', () => ({
  planPropertyDefinitionSynthesis: () => planSynthesis(),
  applyPropertyDefinitionSynthesis: (...args: unknown[]) => applySynthesis(...args),
  flipBlockedBySynthesis: () => flipBlocked(),
}))

/** A plan with `n` keys to mint and nothing wrong. */
const plan = (candidates = 0) => ({
  workspaceId: 'ws-1', refusal: null, syncGap: null,
  candidates: Array.from({length: candidates}, (_, i) => ({
    key: `demo:orphan${i}`, cells: 1, presetId: 'string' as const, notes: [],
  })),
  blockers: [], brokenDefinitions: [],
})

import type { OperatorBackfillResult, Repo } from '@/data/repo'
import { describeOutcome, migratePropertiesToBlocksAction } from '../action.ts'

const clearUndo = vi.fn()
const makeRepo = (result: OperatorBackfillResult, {flipped = false} = {}) => {
  const runWorkspaceBackfillNow = vi.fn(async () => result)
  const getAll = vi.fn(async () => [{n: 7}])
  const repo = {
    activeWorkspaceId: 'ws-1',
    db: {
      getAll,
      getOptional: async () => ({properties_migration: flipped ? 'children' : 'cell'}),
    },
    isReadOnly: false,
    syncViewGap: async () => null,
    undoManagerFor: () => ({clear: clearUndo}),
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
  flipWorkspace.mockReset()
  flipWorkspace.mockResolvedValue({localApplied: true})
  remoteSyncActive.mockReset()
  remoteSyncActive.mockReturnValue(true)
  clearUndo.mockReset()
  showInfo.mockReset()
  progressHandle.update.mockReset()
  progressHandle.done.mockReset()
  progressHandle.fail.mockReset()
  planSynthesis.mockReset()
  planSynthesis.mockResolvedValue(plan())
  applySynthesis.mockReset()
  applySynthesis.mockResolvedValue({created: 0, restored: 0, skipped: []})
  flipBlocked.mockReset()
  flipBlocked.mockReturnValue(null)
})

beforeEach(() => {
  planSynthesis.mockResolvedValue(plan())
  applySynthesis.mockResolvedValue({created: 0, restored: 0, skipped: []})
  flipBlocked.mockReturnValue(null)
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

    // The FLIP as well as the pass: it is the gesture's first write now, and
    // it is the one the trigger will not let anyone take back.
    expect(flipWorkspace).not.toHaveBeenCalled()
    expect(runWorkspaceBackfillNow).not.toHaveBeenCalled()
  })

  it('refuses an already-flipped workspace before the workspace-wide scan', async () => {
    // No flip on this path, so nothing irreversible — but the candidate count is
    // an unbounded json_each walk on the UI thread and the dialog would ask for
    // consent to a run the runner is about to refuse.
    openDialog.mockResolvedValue(true)
    const {repo, runWorkspaceBackfillNow, getAll} = makeRepo(
      {outcome: 'ran', undoHistoryCleared: false}, {flipped: true},
    )
    ;(repo as unknown as {syncViewGap: () => Promise<string | null>}).syncViewGap =
      async () => 'synced rows are still draining into `blocks`'

    await invoke(repo)

    expect(getAll).not.toHaveBeenCalled()
    expect(openDialog).not.toHaveBeenCalled()
    expect(runWorkspaceBackfillNow).not.toHaveBeenCalled()
  })

  it('re-checks fitness after the confirmation, which is a user-length pause', async () => {
    // The early exit above runs BEFORE the dialog. A sync gap that opens while
    // the operator is reading it would otherwise be carried straight into the
    // irreversible write — the same reason the active-workspace check is taken
    // twice.
    const {repo, runWorkspaceBackfillNow} = makeRepo({outcome: 'ran', undoHistoryCleared: false})
    openDialog.mockImplementation(async () => {
      ;(repo as unknown as {syncViewGap: () => Promise<string | null>}).syncViewGap =
        async () => 'synced rows are still draining into `blocks`'
      return true
    })

    await invoke(repo)

    expect(flipWorkspace).not.toHaveBeenCalled()
    expect(runWorkspaceBackfillNow).not.toHaveBeenCalled()
    expect(progressHandle.fail).toHaveBeenCalledWith(expect.stringMatching(/draining/))
  })

  it('refuses before the flip when this device is not fit to write', async () => {
    // The flip is one-way (forward-only by trigger; rollback is a hand-run
    // migration) and the pass that would follow it is not. Running the runner's
    // own preconditions AFTER the flip means the irreversible half lands and the
    // reversible half then declines — on a connected device a staged sync view is
    // the EXPECTED ending, not a corner case.
    openDialog.mockResolvedValue(true)
    const {repo, runWorkspaceBackfillNow} = makeRepo({outcome: 'ran', undoHistoryCleared: false})
    ;(repo as unknown as {syncViewGap: () => Promise<string | null>}).syncViewGap =
      async () => 'synced rows are still draining into `blocks`'

    await invoke(repo)

    expect(flipWorkspace).not.toHaveBeenCalled()
    expect(runWorkspaceBackfillNow).not.toHaveBeenCalled()
    expect(showInfo).toHaveBeenCalledWith(expect.stringMatching(/draining/))
  })

  it('will not flip a workspace this client cannot reach the server for', async () => {
    // Local-only is a RUNTIME choice; `supabase` is built from build-time env, so
    // the client is non-null and the PATCH would really be attempted — against a
    // workspace id that exists nowhere on the server, from a session that has
    // promised to make no Supabase request. Refuse before the dialog rather than
    // fail afterwards on a PostgREST string.
    remoteSyncActive.mockReturnValue(false)
    openDialog.mockResolvedValue(true)
    const {repo, runWorkspaceBackfillNow} = makeRepo({outcome: 'ran', undoHistoryCleared: false})

    await invoke(repo)

    expect(openDialog).not.toHaveBeenCalled()
    expect(flipWorkspace).not.toHaveBeenCalled()
    expect(runWorkspaceBackfillNow).not.toHaveBeenCalled()
  })

  it('still backfills a flipped workspace with sync off, since that needs no server', async () => {
    // The refusal above is about the FLIP, which is a server write. The pass
    // itself is local, so a workspace already past the flip must stay migratable.
    remoteSyncActive.mockReturnValue(false)
    openDialog.mockResolvedValue(true)
    const {repo, runWorkspaceBackfillNow} = makeRepo(
      {outcome: 'ran', undoHistoryCleared: false}, {flipped: true},
    )

    await invoke(repo)

    expect(runWorkspaceBackfillNow).toHaveBeenCalled()
  })

  it('stops when the flip committed but this device cannot see it', async () => {
    // A 0-row local UPDATE is not an error, and the local `workspaces` row can be
    // legitimately absent. Continuing would run the pass against a workspace that
    // reads 'cell' locally and is in fact flipped — the RECONCILE branch, which
    // is the one thing create-only exists to prevent.
    openDialog.mockResolvedValue(true)
    flipWorkspace.mockResolvedValue({localApplied: false})
    const {repo, runWorkspaceBackfillNow} = makeRepo({outcome: 'ran', undoHistoryCleared: false})

    await invoke(repo)

    expect(runWorkspaceBackfillNow).not.toHaveBeenCalled()
    // And it must NOT read as "nothing happened" — the flip is fleet-wide and
    // one-way, and it landed.
    expect(progressHandle.fail).toHaveBeenCalledWith(
      expect.stringMatching(/switched to property blocks/i))
  })

  it('tells an operator whose flip landed and whose pass then deferred', async () => {
    // The wiring, not `describeOutcome` in isolation: the handler is what knows a
    // flip happened, and on a connected device deferring is the expected ending.
    openDialog.mockResolvedValue(true)
    const {repo} = makeRepo({
      outcome: 'deferred', undoHistoryCleared: false, reason: 'this device is not caught up',
    })

    await invoke(repo)

    expect(progressHandle.fail).toHaveBeenCalledWith(
      expect.stringMatching(/switched to property blocks/i))
    expect(progressHandle.fail).not.toHaveBeenCalledWith(expect.stringMatching(/not started/i))
  })

  it('clears undo when the flip commits, not when the pass first writes', async () => {
    // Undo replay drives each row to a whole restored snapshot and SKIPS the
    // same-tx processors, so a cmd-Z of a pre-flip edit restores a cell without
    // the materializer syncing its children — and past the flip the children are
    // the truth. Every way the run can end after the flip WITHOUT writing a batch
    // (a peer holds the claim, the runner defers, nothing left to migrate) leaves
    // that window open if the clear waits for the pass.
    openDialog.mockResolvedValue(true)
    const {repo} = makeRepo({outcome: 'held-by-peer', undoHistoryCleared: false})

    await invoke(repo)

    expect(clearUndo).toHaveBeenCalled()
    expect(progressHandle.fail).toHaveBeenCalledWith(
      expect.stringMatching(/undo history for this workspace was cleared/i))
  })

  it('does not touch undo history for a workspace that was already flipped', async () => {
    // Nothing irreversible happens on that path until the pass itself writes,
    // and the runner clears on its first committed batch.
    openDialog.mockResolvedValue(true)
    const {repo} = makeRepo({outcome: 'ran', undoHistoryCleared: false}, {flipped: true})

    await invoke(repo)

    expect(clearUndo).not.toHaveBeenCalled()
  })

  it('names both irreversible effects when the runner throws outright', async () => {
    // A rejection skips describeOutcome entirely, which is what otherwise
    // carries them — and by then the flip has committed and undo is gone.
    openDialog.mockResolvedValue(true)
    const {repo, runWorkspaceBackfillNow} = makeRepo({outcome: 'ran', undoHistoryCleared: false})
    runWorkspaceBackfillNow.mockRejectedValue(new Error('claim write blew up'))

    await invoke(repo)

    expect(progressHandle.fail).toHaveBeenCalledWith(
      expect.stringMatching(/switched to property blocks/i))
    expect(progressHandle.fail).toHaveBeenCalledWith(
      expect.stringMatching(/undo history for this workspace was cleared/i))
  })

  it('flips the workspace before running the pass, not after', async () => {
    // The whole runbook in one assertion. The flip turns the live maintainers
    // on, so a workspace flipped with zero children starts growing them from
    // the next write while reads keep coming from the cell; backfilling first
    // leaves a window where machinery exists that nothing recognizes and
    // nothing maintains.
    openDialog.mockResolvedValue(true)
    const order: string[] = []
    flipWorkspace.mockImplementation(async () => { order.push('flip'); return {localApplied: true} })
    const {repo, runWorkspaceBackfillNow} = makeRepo({outcome: 'ran', undoHistoryCleared: false})
    runWorkspaceBackfillNow.mockImplementation(async () => {
      order.push('backfill')
      return {outcome: 'ran', undoHistoryCleared: false} as OperatorBackfillResult
    })

    await invoke(repo)

    expect(order).toEqual(['flip', 'backfill'])
    expect(openDialog).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({childBacked: false}))
  })

  it('migrates nothing when the flip is refused, and says so', async () => {
    // The trigger refuses a non-owner, an e2ee workspace and any step other
    // than cell -> children. The flip is the gesture's FIRST write, so a
    // refusal leaves the graph untouched — which is the part an operator needs
    // told, rather than being left to wonder what landed.
    openDialog.mockResolvedValue(true)
    flipWorkspace.mockRejectedValue(new Error('workspaces.properties_migration is writable by the workspace owner'))
    const {repo, runWorkspaceBackfillNow} = makeRepo({outcome: 'ran', undoHistoryCleared: false})

    await invoke(repo)

    expect(runWorkspaceBackfillNow).not.toHaveBeenCalled()
    expect(progressHandle.fail).toHaveBeenCalledWith(expect.stringMatching(/nothing was migrated/i))
  })

  it('backfills an already-flipped workspace without re-flipping it', async () => {
    // Refusing here — "the migration has nothing left to do" — left an operator
    // who had already flipped with no way to run the pass at all. Re-flipping
    // would be no better: forward-only, so a second flip is at best a no-op
    // write on the one gesture an operator repeats to catch stragglers.
    openDialog.mockResolvedValue(true)
    const {repo, runWorkspaceBackfillNow} = makeRepo(
      {outcome: 'ran', undoHistoryCleared: false}, {flipped: true},
    )

    await invoke(repo)

    expect(flipWorkspace).not.toHaveBeenCalled()
    expect(runWorkspaceBackfillNow).toHaveBeenCalled()
    // The confirmation is the only place an operator finds out which of the two
    // jobs they are starting.
    expect(openDialog).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({childBacked: true}))
  })

  it('does not run against a workspace the user left while confirming', async () => {
    // The runner's own active-workspace check runs only AFTER `tryClaim` has
    // written a Migrations page and a claim row, so a stale pin means two
    // blocks land in a graph the user never meant to touch.
    const {repo, runWorkspaceBackfillNow} = makeRepo({outcome: 'ran', undoHistoryCleared: true})
    openDialog.mockImplementation(dialogThatSwitchesWorkspace(repo))

    await invoke(repo)

    // Flipping the wrong graph is the worse half: forward-only by trigger, so
    // unlike a stray Migrations page it cannot be undone by a column write.
    expect(flipWorkspace).not.toHaveBeenCalled()
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

describe('the orphan-definition step', () => {
  it('refuses the flip when a key can never have a definition, before anything is scanned', async () => {
    // The hard case: such a key makes "every cell key resolves a definition"
    // unsatisfiable forever, and the flip is one-way. Refusing after the flip
    // would be refusing after the damage.
    flipBlocked.mockReturnValue('2 property key(s) cannot be given a definition')
    const {repo, runWorkspaceBackfillNow, getAll} = makeRepo({outcome: 'ran', undoHistoryCleared: false})

    await invoke(repo)

    expect(showInfo).toHaveBeenCalledWith(
      expect.stringMatching(/cannot be given a definition/), expect.anything())
    expect(getAll).not.toHaveBeenCalled()
    expect(openDialog).not.toHaveBeenCalled()
    expect(flipWorkspace).not.toHaveBeenCalled()
    expect(runWorkspaceBackfillNow).not.toHaveBeenCalled()
  })

  it('lets an already-flipped workspace run anyway, because there is nothing left to guard', async () => {
    // Withholding the backfill from every OTHER key over a handful that can
    // never migrate would be the worse trade — and no irreversible step
    // remains on this path.
    flipBlocked.mockReturnValue('2 property key(s) cannot be given a definition')
    openDialog.mockResolvedValue(true)
    const {repo, runWorkspaceBackfillNow} = makeRepo(
      {outcome: 'ran', undoHistoryCleared: false}, {flipped: true})

    await invoke(repo)

    expect(runWorkspaceBackfillNow).toHaveBeenCalled()
  })

  it('mints the missing definitions BEFORE it flips', async () => {
    // The §9 runbook order. A definition is a dormant block at 'cell', so
    // minting early is free; minting after the flip leaves a window in which
    // the pass skips those keys and reports success over them.
    planSynthesis.mockResolvedValue(plan(3))
    openDialog.mockResolvedValue(true)
    const {repo} = makeRepo({outcome: 'ran', undoHistoryCleared: false})

    await invoke(repo)

    expect(applySynthesis).toHaveBeenCalled()
    expect(applySynthesis.mock.invocationCallOrder[0]!)
      .toBeLessThan(flipWorkspace.mock.invocationCallOrder[0]!)
  })

  it('does not flip when the definitions could not be minted', async () => {
    planSynthesis.mockResolvedValue(plan(3))
    applySynthesis.mockRejectedValue(new Error('nope'))
    openDialog.mockResolvedValue(true)
    const {repo, runWorkspaceBackfillNow} = makeRepo({outcome: 'ran', undoHistoryCleared: false})

    await invoke(repo)

    expect(flipWorkspace).not.toHaveBeenCalled()
    expect(runWorkspaceBackfillNow).not.toHaveBeenCalled()
    expect(progressHandle.fail).toHaveBeenCalledWith(expect.stringMatching(/nothing was migrated/))
  })

  it('does not mint into a workspace the plan refused', async () => {
    // e2ee today. `flipBlockedBySynthesis` is what decides whether that stops
    // the gesture; what must not happen either way is writing anyway.
    planSynthesis.mockResolvedValue({...plan(2), refusal: 'this workspace is encrypted'})
    openDialog.mockResolvedValue(true)
    const {repo} = makeRepo({outcome: 'ran', undoHistoryCleared: false}, {flipped: true})

    await invoke(repo)

    expect(applySynthesis).not.toHaveBeenCalled()
    // And the dialog does not promise the minting it is about to skip.
    expect(openDialog).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({synthesizedKeys: 0, unfixableKeys: 2}))
  })

  it('does not mint into a workspace the operator navigated away from', async () => {
    // The confirmation is a user-length pause. Minting past the re-check would
    // write definitions into the graph they just left — the same reason the
    // flip takes that check twice.
    planSynthesis.mockResolvedValue(plan(3))
    const {repo} = makeRepo({outcome: 'ran', undoHistoryCleared: false})
    openDialog.mockImplementation(dialogThatSwitchesWorkspace(repo))

    await invoke(repo)

    expect(applySynthesis).not.toHaveBeenCalled()
  })

  it('stops without writing when the plan itself cannot be built', async () => {
    planSynthesis.mockRejectedValue(new Error('registry is not loaded'))
    const {repo, runWorkspaceBackfillNow} = makeRepo({outcome: 'ran', undoHistoryCleared: false})

    await invoke(repo)

    expect(showInfo).toHaveBeenCalledWith(expect.stringMatching(/registry is not loaded/))
    expect(openDialog).not.toHaveBeenCalled()
    expect(flipWorkspace).not.toHaveBeenCalled()
    expect(runWorkspaceBackfillNow).not.toHaveBeenCalled()
  })
})

describe('what a completed run tells the operator', () => {
  const ran = {outcome: 'ran', undoHistoryCleared: false} as const
  const counts = (blocks: number) =>
    ({blocksMaterialized: blocks, valuesMaterializedTotal: blocks, unmigrated: 0, orphanedOwnersSwept: 0})

  it('calls a run that migrated nothing a failure, not a green "0 blocks"', async () => {
    // Failures are per-value by design, so a systematic problem — a codec
    // rejecting everything, storage refusing writes — otherwise came back as
    // a success banner reading "Migrated properties on 0 blocks."
    const {message, failed} = describeOutcome(ran, {blocksMaterialized: 0, valuesMaterializedTotal: 0, unmigrated: 12, orphanedOwnersSwept: 0}, false)

    expect(failed).toBe(true)
    expect(message).toMatch(/systematic/i)
  })

  it('reports what it DELETED, which nothing else does', async () => {
    // The sweep that removes stale children is by construction never the one
    // that converges, and every other count is per-sweep — so a run whose only
    // effect was deletion otherwise reads "Migrated properties on 0 blocks."
    const {message} = describeOutcome(
      ran,
      {blocksMaterialized: 0, valuesMaterializedTotal: 0, unmigrated: 0, orphanedOwnersSwept: 4},
      false,
    )

    expect(message).toMatch(/removed the property children of 4/i)
  })

  it('is not "systematic" when one bad key per block hid a mostly-good run', async () => {
    // `blocksMaterialized` counts blocks accepted in FULL, so it reads zero for
    // a run that wrote every other key on every block. Branching on it told the
    // operator nothing was migrated while tens of thousands of rows were.
    const {failed} = describeOutcome(
      ran, {blocksMaterialized: 0, valuesMaterializedTotal: 40, unmigrated: 20, orphanedOwnersSwept: 0}, false,
    )

    expect(failed).toBe(false)
  })

  it('never says a flipped workspace was untouched, whatever the pass did', async () => {
    // The flip is fleet-wide and one-way, and every non-`ran` outcome was worded
    // when the gesture's only write was the pass. "Not started" after a committed
    // flip sends the operator away believing the graph is as they left it.
    const outcomes: OperatorBackfillResult[] = [
      {outcome: 'deferred', undoHistoryCleared: false, reason: 'this device is not caught up'},
      {outcome: 'failed', undoHistoryCleared: false, reason: 'something broke'},
      {outcome: 'held-by-peer', undoHistoryCleared: false},
      {outcome: 'already-running', undoHistoryCleared: false},
    ]
    for (const result of outcomes) {
      const {message} = describeOutcome(result, counts(0), false, {flipped: true})
      expect(message, result.outcome).toMatch(/switched to property blocks/i)
      expect(message, result.outcome).not.toMatch(/not started/i)
    }
  })

  it('says nothing about a flip on a workspace that was already past it', async () => {
    // The un-flipped runs are the only ones that owe that sentence; adding it to
    // every run would tell an operator their gesture did something it did not.
    expect(describeOutcome(
      {outcome: 'deferred', undoHistoryCleared: false, reason: 'busy'},
      counts(0), false, {flipped: false},
    ).message).not.toMatch(/switched to property blocks/i)
  })

  it('says to run again when the workspace was edited under the pass', async () => {
    // Convergence deliberately does not loop on rewritten values, so this
    // sentence is the only thing that tells an operator the children it just
    // built may already be behind the cells.
    expect(describeOutcome(ran, counts(100), true, {flipped: false}).message).toMatch(/run this again/i)
    expect(describeOutcome(ran, counts(100), false, {flipped: false}).message).not.toMatch(/run this again/i)
  })
})

describe('what an aborted run tells the operator', () => {
  const counts = (blocks: number) =>
    ({blocksMaterialized: blocks, valuesMaterializedTotal: blocks, unmigrated: 0, orphanedOwnersSwept: 0})

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
