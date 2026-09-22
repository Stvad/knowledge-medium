// @vitest-environment happy-dom
/**
 * The palette entry for the one-time properties migration. What matters here
 * is the gesture's guard and what the user is told afterwards — the pass
 * itself is covered in `propertyCellBackfill.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const openDialog = vi.fn()
const progressHandle = {
  update: vi.fn(), done: vi.fn(), fail: vi.fn(), settleUnreported: vi.fn(),
  addNote: vi.fn(),
}

vi.mock('@/utils/dialogs.js', () => ({openDialog: (...args: unknown[]) => openDialog(...args)}))
const showInfo = vi.fn()
const dismissToast = vi.fn()
vi.mock('@/utils/toast.js', () => ({
  showInfo: (...args: unknown[]) => showInfo(...args),
  dismissToast: (...args: unknown[]) => dismissToast(...args),
}))
vi.mock('../progressReport.ts', () => ({
  reportMigrationProgress: () => progressHandle,
}))
vi.mock('../ConfirmMigrationDialog.tsx', () => ({ConfirmMigrationDialog: () => null}))
const flipWorkspace = vi.fn<(repo: unknown, workspaceId: string) => Promise<{localApplied: boolean}>>()
vi.mock('@/data/workspaces', async (importOriginal) => ({
  // The predicate is NOT stubbed: it reads the marker the real flip attaches,
  // and a stub here would let this file agree with itself about which
  // rejections prove nothing was written.
  ...(await importOriginal<typeof import('@/data/workspaces')>()),
  flipWorkspaceToChildBackedProperties: (repo: unknown, workspaceId: string) =>
    flipWorkspace(repo, workspaceId),
}))
const remoteSyncActive = vi.fn<() => boolean>()
vi.mock('@/data/repoProvider', () => ({isRemoteSyncActive: () => remoteSyncActive()}))
// §9 synthesis. Faked here so this file stays about the gesture's ORDER —
// what the plan says, and what the gesture does about it. What the plan means
// is `propertyDefinitionSynthesis.test.ts`.
const planSynthesis = vi.fn()
/** Typed, so a field added to `SynthesisResult` fails HERE rather than arriving
 *  as `undefined` in every test that stubs it. It already had drifted: one
 *  literal was missing `converged`, and the untyped stub took it. */
const applySynthesis = vi.fn<(...args: unknown[]) => Promise<SynthesisResult>>()

/** A synthesis outcome at its no-op values; override only what the test is
 *  about, so a stub says what it is testing and nothing else. */
const synthesized = (over: Partial<SynthesisResult> = {}): SynthesisResult =>
  ({created: 0, converged: 0, skipped: [], undoHistoryCleared: false, ...over})
const flipBlocked = vi.fn<() => string | null>()
vi.mock('@/data/internals/propertyDefinitionSynthesis', () => ({
  planPropertyDefinitionSynthesis: () => planSynthesis(),
  applyPropertyDefinitionSynthesis: (...args: unknown[]) => applySynthesis(...args),
  flipBlockedBySynthesis: () => flipBlocked(),
}))

/** The pre-dialog survey of stored cell values, faked for the same reason the
 *  plan above is: this file is about the gesture's ORDER — when the scan runs,
 *  and what the gesture does with its verdict. What the verdict MEANS is
 *  `propertyCellBackfill.test.ts`. Partial, so `pendingValueCount` and the
 *  pass id stay real. */
const surveyCells = vi.fn<() => Promise<PropertyCellRejectionSurvey>>()
const cellValuesBlocked = vi.fn<() => string | null>()
vi.mock('@/data/internals/propertyCellBackfill', async importOriginal => ({
  ...(await importOriginal<typeof import('@/data/internals/propertyCellBackfill')>()),
  surveyPropertyCellRejections: () => surveyCells(),
  flipBlockedByCellValues: () => cellValuesBlocked(),
}))

/** A plan with `n` keys to mint and nothing wrong. */
const plan = (candidates = 0) => ({
  workspaceId: 'ws-1', refusal: null, unreadableBlocks: 0,
  candidates: Array.from({length: candidates}, (_, i) => ({
    key: `demo:orphan${i}`, cells: 1, presetId: 'string' as const, notes: [],
  })),
  blockers: [], brokenDefinitions: [],
})

import type { OperatorBackfillResult, Repo, ViewGap } from '@/data/repo'
import type { SynthesisResult } from '@/data/internals/propertyDefinitionSynthesis'
import type { PropertyCellRejectionSurvey } from '@/data/internals/propertyCellBackfill'
import type { HistoryDrop } from '@/data/internals/undoManager'
import { getClientId } from '@/utils/clientId'
import { claimStub, type ClaimStubLog } from './claimStub.ts'
import { type RunCounts, describeOutcome, migratePropertiesToBlocksAction } from '../action.ts'

const clearUndo = vi.fn()
const finishUndoDrop = vi.fn()
const abandonUndoDrop = vi.fn()
const beginHistoryDrop = vi.fn(
  (): HistoryDrop => ({finish: finishUndoDrop, abandon: abandonUndoDrop}))
const USER = 'user-1'

const RAN = {outcome: 'ran', undoHistoryCleared: false} as OperatorBackfillResult

/** The gap a device reports mid-drain: real text, and TRANSIENT, which is the
 *  half the action does not read — it reports the reason and stops either way. */
const DRAINING: ViewGap = {
  reason: 'synced rows are still draining into `blocks`', transient: true,
}

/** The other kind: nothing is in flight, so retrying alone changes nothing. */
const STRANDED: ViewGap = {
  reason: '3 synced row(s) have not reached `blocks`', transient: false,
}

const makeRepo = (
  result: OperatorBackfillResult = RAN,
  {flipped = false, owner = USER, refuseClaim, log, claimedBy}: {
    flipped?: boolean
    owner?: string
    refuseClaim?: () => OperatorBackfillResult | null
    log?: ClaimStubLog
    /** A live claim already on the workspace when the gesture starts. */
    claimedBy?: string
  } = {},
) => {
  const runPass = vi.fn(async () => result)
  const getAll = vi.fn(async () => [])
  const workspaceViewGap = vi.fn(async (): Promise<ViewGap | null> => null)
  // Two readers of the `workspaces` row now — the flip state and the owner.
  const getOptional = vi.fn(async (sql: string) => {
    if (sql.includes('owner_user_id')) return {owner_user_id: owner}
    if (sql.includes('properties_json')) {
      return claimedBy === undefined ? null : {
        properties_json: JSON.stringify({
          'migration:claimant': claimedBy, 'migration:claimed-at': 1,
        }),
      }
    }
    return {properties_migration: flipped ? 'children' : 'cell'}
  })
  const repo = {
    activeWorkspaceId: 'ws-1',
    user: {id: USER},
    db: {getAll, getOptional},
    isReadOnly: false,
    workspaceViewGap,
    undoManagerFor: () => ({clear: clearUndo, beginHistoryDrop}),
    // The gesture reaches the pass THROUGH the claim, so the stub is the only
    // route to `runPass`. `repo.runPass` is deliberately
    // ABSENT: a fixture that also answered that call directly would keep
    // every assertion below green through a revert to it — which is the bug
    // (#710) this file exists to pin. Missing, it is a TypeError instead.
    withOperatorBackfillClaim: claimStub(runPass, {log, refuse: refuseClaim}),
  } as unknown as Repo
  return {repo, runPass, getAll, workspaceViewGap, getOptional}
}

/** The dialog is a user-length pause; this is the seam for what happens during
 *  it. */
const dialogThatSwitchesWorkspace = (repo: Repo) => async () => {
  ;(repo as unknown as {activeWorkspaceId: string}).activeWorkspaceId = 'ws-2'
  return true
}

/** The counts `describeOutcome` reports on, for a run that migrated `blocks`
 *  blocks cleanly. Shared by every describe that renders an outcome. */
const counts = (blocks: number, over: Partial<RunCounts> = {}): RunCounts => ({
  blocksMaterializedTotal: blocks, valuesMaterializedTotal: blocks, unmigrated: 0,
  unresolved: 0, unresolvedNames: [], ...over,
})

describe('a workspace another client is already migrating', () => {
  it('refuses before the consent screen, rather than after it', async () => {
    // The confirmation asks consent for a one-way fleet-wide flip and says
    // nothing about a run already under way — and the palette stays reachable
    // through the gate's own modal, so this is how a user meets it. `tryClaim`
    // would decline anyway; the point is the screen they are not asked to read.
    const {repo, runPass} = makeRepo(RAN, {claimedBy: 'a-peer'})

    await invoke(repo)

    expect(openDialog).not.toHaveBeenCalled()
    expect(runPass).not.toHaveBeenCalled()
    expect(showInfo).toHaveBeenCalledWith(
      expect.stringContaining('Another client is already migrating'))
  })

  it('lets OUR OWN claimant through, because that is what a resume is', async () => {
    // An inherited claim is the state "run this again to resume it" starts
    // from — the advice the gesture's own report gives after an interrupted
    // run. Refusing it here would make that advice impossible to follow.
    const {repo, runPass} = makeRepo(RAN, {claimedBy: getClientId()})

    await invoke(repo)

    expect(openDialog).toHaveBeenCalled()
    expect(runPass).toHaveBeenCalled()
  })
})

const invoke = (repo: Repo) =>
  migratePropertiesToBlocksAction({repo}).handler({} as never, {} as never)

afterEach(() => {
  clearUndo.mockReset()
  finishUndoDrop.mockReset()
  abandonUndoDrop.mockReset()
  beginHistoryDrop.mockClear()
  showInfo.mockReset()
  dismissToast.mockReset()
  progressHandle.update.mockReset()
  progressHandle.done.mockReset()
  progressHandle.fail.mockReset()
  progressHandle.settleUnreported.mockReset()
  progressHandle.addNote.mockReset()
  planSynthesis.mockReset()
  planSynthesis.mockResolvedValue(plan())
  applySynthesis.mockReset()
  flipBlocked.mockReset()
  surveyCells.mockReset()
  cellValuesBlocked.mockReset()
})

// Every default lives HERE, not split with `afterEach`: arming in `afterEach`
// alone leaves the first test of a run — and any `vitest -t "<name>"` — running
// against unarmed mocks, which silently took the local-only branch.
beforeEach(() => {
  openDialog.mockReset()
  openDialog.mockResolvedValue(true)
  flipWorkspace.mockReset()
  flipWorkspace.mockResolvedValue({localApplied: true})
  remoteSyncActive.mockReset()
  remoteSyncActive.mockReturnValue(true)
  planSynthesis.mockResolvedValue(plan())
  applySynthesis.mockResolvedValue(synthesized())
  flipBlocked.mockReturnValue(null)
  surveyCells.mockResolvedValue({keys: [], cells: 0, blocksScanned: 7})
  cellValuesBlocked.mockReturnValue(null)
})

describe('migrate_properties_to_blocks action', () => {
  it('takes the synthesis advisory down once a re-run comes back clean', async () => {
    // It has no duration and a stable id, so it outlives the problem it named:
    // without this the operator repairs the definitions, re-runs, and reads a
    // "cannot migrate" banner through a migration that is succeeding.
    const {repo} = makeRepo(RAN, {flipped: true})
    flipBlocked.mockReturnValue('two keys can never be migrated')
    await invoke(repo)
    // Read off the advisory rather than written down here, so the two cannot
    // drift onto different toasts and still pass.
    const advisory = (showInfo.mock.calls[0]![1] as {id: string}).id
    expect(advisory).toBeTruthy()

    showInfo.mockReset()
    dismissToast.mockReset()
    flipBlocked.mockReturnValue(null)
    await invoke(repo)

    expect(dismissToast).toHaveBeenCalledWith(advisory)
  })

  it('fails the banner when the post-dialog eligibility read throws', async () => {
    // The banner is up by then and has no duration, and nothing else is
    // watching this await — a rejection would leave "Migrating properties to
    // blocks…" on screen forever over a pass that never started.
    const {repo, runPass, workspaceViewGap} = makeRepo()
    workspaceViewGap.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('db is gone'))

    await invoke(repo)

    expect(progressHandle.fail).toHaveBeenCalledWith(expect.stringContaining('Not started'))
    expect(runPass).not.toHaveBeenCalled()
  })

  it('does not tell the operator to retry a refusal that retrying cannot clear', async () => {
    // The message is their only feedback. Told "try again shortly" about a gap
    // nothing is working on, they retry forever — and this refusal is the one
    // that means a recovery gesture is needed, not patience.
    const {repo, runPass, workspaceViewGap} = makeRepo()
    workspaceViewGap.mockResolvedValue(STRANDED)

    await invoke(repo)

    expect(showInfo).toHaveBeenCalledWith(
      expect.stringContaining('retrying alone will not clear this'))
    expect(showInfo).not.toHaveBeenCalledWith(expect.stringContaining('try again shortly'))
    expect(runPass).not.toHaveBeenCalled()
  })

  it('writes nothing when the user cancels the confirmation', async () => {
    // The confirmation is the whole guard on a pass that uploads hundreds of
    // thousands of rows and drops the workspace's undo history.
    openDialog.mockResolvedValue(null)
    const {repo, runPass} = makeRepo(
      {outcome: 'ran', undoHistoryCleared: true},
    )

    await invoke(repo)

    // The FLIP as well as the pass: it is the gesture's first write now, and
    // it is the one the trigger will not let anyone take back.
    expect(flipWorkspace).not.toHaveBeenCalled()
    expect(runPass).not.toHaveBeenCalled()
  })

  it('refuses an already-flipped workspace before the workspace-wide scan', async () => {
    // No flip on this path, so nothing irreversible — but the cell survey is an
    // unbounded walk of every property bag on the UI thread, and the dialog
    // would ask for consent to a run the runner is about to refuse.
    const {repo, runPass, workspaceViewGap} = makeRepo(RAN, {flipped: true})
    workspaceViewGap.mockResolvedValue(DRAINING)

    await invoke(repo)

    expect(surveyCells).not.toHaveBeenCalled()
    expect(openDialog).not.toHaveBeenCalled()
    expect(runPass).not.toHaveBeenCalled()
  })

  it('re-checks fitness after the confirmation, which is a user-length pause', async () => {
    // The early exit above runs BEFORE the dialog. A sync gap that opens while
    // the operator is reading it would otherwise be carried straight into the
    // irreversible write — the same reason the active-workspace check is taken
    // twice.
    const {repo, runPass, workspaceViewGap} = makeRepo()
    openDialog.mockImplementation(async () => {
      workspaceViewGap.mockResolvedValue(DRAINING)
      return true
    })

    await invoke(repo)

    expect(flipWorkspace).not.toHaveBeenCalled()
    expect(runPass).not.toHaveBeenCalled()
    expect(progressHandle.fail).toHaveBeenCalledWith(expect.stringMatching(/draining/))
  })

  it('refuses before the flip when this device is not fit to write', async () => {
    // The flip is one-way (forward-only by trigger; rollback is a hand-run
    // migration) and the pass that would follow it is not. Running the runner's
    // own preconditions AFTER the flip means the irreversible half lands and the
    // reversible half then declines — on a connected device a staged sync view is
    // the EXPECTED ending, not a corner case.
    const {repo, runPass, workspaceViewGap} = makeRepo()
    workspaceViewGap.mockResolvedValue(DRAINING)

    await invoke(repo)

    expect(flipWorkspace).not.toHaveBeenCalled()
    expect(runPass).not.toHaveBeenCalled()
    expect(showInfo).toHaveBeenCalledWith(expect.stringMatching(/draining/))
  })

  it('will not flip a workspace this client cannot reach the server for', async () => {
    // Local-only is a RUNTIME choice; `supabase` is built from build-time env, so
    // the client is non-null and the PATCH would really be attempted — against a
    // workspace id that exists nowhere on the server, from a session that has
    // promised to make no Supabase request. Refuse before the dialog rather than
    // fail afterwards on a PostgREST string.
    remoteSyncActive.mockReturnValue(false)
    const {repo, runPass} = makeRepo()

    await invoke(repo)

    expect(openDialog).not.toHaveBeenCalled()
    expect(flipWorkspace).not.toHaveBeenCalled()
    expect(runPass).not.toHaveBeenCalled()
  })

  it('still backfills a flipped workspace with sync off, since that needs no server', async () => {
    // The refusal above is about the FLIP, which is a server write. The pass
    // itself is local, so a workspace already past the flip must stay migratable.
    remoteSyncActive.mockReturnValue(false)
    const {repo, runPass} = makeRepo(
      RAN, {flipped: true},
    )

    await invoke(repo)

    expect(runPass).toHaveBeenCalled()
  })

  it('stops when the flip committed but this device cannot see it', async () => {
    // A 0-row local UPDATE is not an error, and the local `workspaces` row can be
    // legitimately absent. Continuing would run the pass against a workspace that
    // reads 'cell' locally and is in fact flipped — the RECONCILE branch, which
    // is the one thing create-only exists to prevent.
    flipWorkspace.mockResolvedValue({localApplied: false})
    const {repo, runPass} = makeRepo()

    await invoke(repo)

    expect(runPass).not.toHaveBeenCalled()
    // And it must NOT read as "nothing happened" — the flip is fleet-wide and
    // one-way, and it landed.
    expect(progressHandle.fail).toHaveBeenCalledWith(
      expect.stringMatching(/switched to property blocks/i))
  })

  it('tells an operator whose flip landed and whose pass then deferred', async () => {
    // The wiring, not `describeOutcome` in isolation: the handler is what knows a
    // flip happened, and on a connected device deferring is the expected ending.
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
    const {repo} = makeRepo({outcome: 'held-by-peer', undoHistoryCleared: false})

    await invoke(repo)

    expect(finishUndoDrop).toHaveBeenCalled()
    // Through the PAIRED api, never a bare `clear()` — that one cannot reach a
    // replay `undo()` has already popped, which is the whole hazard here.
    expect(clearUndo).not.toHaveBeenCalled()
    expect(progressHandle.fail).toHaveBeenCalledWith(
      expect.stringMatching(/undo history for this workspace was cleared/i))
  })

  it('refuses in-flight replays BEFORE the flip, not with the clear after it', async () => {
    // From the PATCH onward the workspace is child-backed for the whole graph,
    // and the flip is a network round trip plus two local db calls — room for a
    // replay `undo()` has already popped to take the write lock and commit a
    // whole pre-flip row. The `clear()` afterwards cannot reach that entry: it
    // is off the stack by then. Only the epoch bump refuses it, and it has to
    // land before the workspace changes underneath.
    const order: string[] = []
    beginHistoryDrop.mockImplementation(() => {
      order.push('begin')
      return {finish: finishUndoDrop, abandon: abandonUndoDrop}
    })
    finishUndoDrop.mockImplementation(() => { order.push('finish') })
    flipWorkspace.mockImplementation(async () => { order.push('flip'); return {localApplied: true} })
    const {repo} = makeRepo(RAN)

    await invoke(repo)

    expect(order.slice(0, 3)).toEqual(['begin', 'flip', 'finish'])
    flipWorkspace.mockReset()
    flipWorkspace.mockResolvedValue({localApplied: true})
  })

  it('drops the history when the flip FAILS ambiguously, not just when it lands', async () => {
    // `flipWorkspaceToChildBackedProperties` throws only when the PATCH errored
    // AND the confirming re-read could not be got either — so the server may be
    // child-backed already. Keeping the history there leaves every pre-flip
    // entry replayable over a flip that did land, and the epoch has already
    // moved, so nothing else refuses them. Dropped on the side of the rows.
    flipWorkspace.mockRejectedValue(new Error('response lost'))
    const {repo} = makeRepo()

    await invoke(repo)

    expect(finishUndoDrop).toHaveBeenCalled()
    expect(progressHandle.fail).toHaveBeenCalledWith(
      expect.stringMatching(/undo history for this workspace was cleared/i))
    flipWorkspace.mockReset()
    flipWorkspace.mockResolvedValue({localApplied: true})
  })

  it('tells the operator an ambiguous flip is ambiguous, not that nothing happened', async () => {
    // The branch that DROPPED their undo history because the flip may have
    // landed must not then tell them it did not. The two halves of that message
    // would contradict each other, and "nothing was migrated" sends them to
    // re-run against a graph that may already have moved.
    flipWorkspace.mockRejectedValue(new Error('response lost'))
    const {repo} = makeRepo()

    await invoke(repo)

    expect(progressHandle.fail).toHaveBeenCalledWith(
      expect.stringMatching(/could not tell whether/i))
    expect(progressHandle.fail).not.toHaveBeenCalledWith(
      expect.stringMatching(/nothing was migrated/i))
    flipWorkspace.mockReset()
    flipWorkspace.mockResolvedValue({localApplied: true})
  })

  it('keeps the history when the flip rejection PROVES nothing was written', async () => {
    // The other half of the branch above. When the confirming re-read comes
    // back and still says `cell`, the flip demonstrably did not land — an
    // ordinary refusal, a trigger or a permission — and charging the user their
    // undo history for it would be a cost with no hazard. The marker is what
    // tells the two apart; both carry the same underlying PostgREST error.
    flipWorkspace.mockRejectedValue(Object.assign(new Error('refused'), {flipLanded: false}))
    const {repo} = makeRepo()

    await invoke(repo)

    expect(finishUndoDrop).not.toHaveBeenCalled()
    // ENDED all the same: a drop left open refuses every replay in this
    // workspace until the page reloads.
    expect(abandonUndoDrop).toHaveBeenCalled()
    expect(progressHandle.fail).not.toHaveBeenCalledWith(
      expect.stringMatching(/undo history for this workspace was cleared/i))
    flipWorkspace.mockReset()
    flipWorkspace.mockResolvedValue({localApplied: true})
  })

  it('does not touch undo history for a workspace that was already flipped', async () => {
    // Nothing irreversible happens on that path until the pass itself writes,
    // and the runner clears on its first committed batch.
    const {repo} = makeRepo(RAN, {flipped: true})

    await invoke(repo)

    expect(beginHistoryDrop).not.toHaveBeenCalled()
    expect(clearUndo).not.toHaveBeenCalled()
  })

  it('names both irreversible effects when the runner throws outright', async () => {
    // A rejection skips describeOutcome entirely, which is what otherwise
    // carries them — and by then the flip has committed and undo is gone.
    const {repo, runPass} = makeRepo()
    runPass.mockRejectedValue(new Error('claim write blew up'))

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
    const order: string[] = []
    flipWorkspace.mockImplementation(async () => { order.push('flip'); return {localApplied: true} })
    const {repo, runPass} = makeRepo()
    runPass.mockImplementation(async () => {
      order.push('backfill')
      return RAN
    })

    await invoke(repo)

    expect(order).toEqual(['flip', 'backfill'])
    expect(openDialog).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({childBacked: false}))
  })

  it('migrates nothing when the flip is refused, and says so', async () => {
    // The trigger refuses a non-owner and any step other than cell -> children.
    // The flip is the gesture's FIRST write, so a
    // refusal leaves the graph untouched — which is the part an operator needs
    // told, rather than being left to wonder what landed.
    flipWorkspace.mockRejectedValue(Object.assign(
      new Error('workspaces.properties_migration is writable by the workspace owner'),
      {flipLanded: false}))
    const {repo, runPass} = makeRepo()

    await invoke(repo)

    expect(runPass).not.toHaveBeenCalled()
    expect(progressHandle.fail).toHaveBeenCalledWith(expect.stringMatching(/nothing was migrated/i))
  })

  it('backfills an already-flipped workspace without re-flipping it', async () => {
    // Refusing here — "the migration has nothing left to do" — left an operator
    // who had already flipped with no way to run the pass at all. Re-flipping
    // would be no better: forward-only, so a second flip is at best a no-op
    // write on the one gesture an operator repeats to catch stragglers.
    const {repo, runPass} = makeRepo(
      RAN, {flipped: true},
    )

    await invoke(repo)

    expect(flipWorkspace).not.toHaveBeenCalled()
    expect(runPass).toHaveBeenCalled()
    // The confirmation is the only place an operator finds out which of the two
    // jobs they are starting.
    expect(openDialog).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({childBacked: true}))
  })

  it('does not run against a workspace the user left while confirming', async () => {
    // The runner's own active-workspace check runs only AFTER `tryClaim` has
    // written a Migrations page and a claim row, so a stale pin means two
    // blocks land in a graph the user never meant to touch.
    const {repo, runPass} = makeRepo({outcome: 'ran', undoHistoryCleared: true})
    openDialog.mockImplementation(dialogThatSwitchesWorkspace(repo))

    await invoke(repo)

    // Flipping the wrong graph is the worse half: forward-only by trigger, so
    // unlike a stray Migrations page it cannot be undone by a column write.
    expect(flipWorkspace).not.toHaveBeenCalled()
    expect(runPass).not.toHaveBeenCalled()
  })

  it('tells the user their undo history went with it', async () => {
    const {repo} = makeRepo({outcome: 'ran', undoHistoryCleared: true})

    await invoke(repo)

    expect(progressHandle.done).toHaveBeenCalledWith(expect.stringMatching(/undo history/i))
  })

  it('reports a deferred pass as unfinished rather than as done', async () => {
    // `deferred` means a precondition that clears on its own. Reporting it
    // through `done` would read as "migration complete" to the one person who
    // needs to come back and re-run it.
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

describe('the graph-wide claim', () => {
  it('is taken before synthesis, and handed back only at the end', async () => {
    // The bug this pins (#710): the claim used to be taken inside the pass,
    // which is the LAST thing this gesture does, while synthesis and the flip
    // both write before it.
    const log: ClaimStubLog = {events: []}
    const {repo} = makeRepo(RAN, {log})
    planSynthesis.mockResolvedValue(plan(1))
    applySynthesis.mockImplementation(async () => {
      log.events.push('synthesize')
      return synthesized({created: 1, undoHistoryCleared: true})
    })
    flipWorkspace.mockImplementation(async () => {
      log.events.push('flip')
      return {localApplied: true}
    })

    await invoke(repo)

    expect(log.events).toEqual(['claim', 'synthesize', 'flip', 'run', 'release'])
  })

  it('stops before synthesis when another device holds it, and says where it lives', async () => {
    // "Another device is doing this" has to arrive BEFORE this one writes its
    // own definitions, and it has to name the recovery: no timeout releases a
    // claim whose device never came back.
    const {repo} = makeRepo(RAN, {
      refuseClaim: () => ({outcome: 'held-by-peer', undoHistoryCleared: false}),
    })
    planSynthesis.mockResolvedValue(plan(2))

    await invoke(repo)

    expect(applySynthesis).not.toHaveBeenCalled()
    expect(flipWorkspace).not.toHaveBeenCalled()
    expect(progressHandle.fail).toHaveBeenCalledWith(
      expect.stringMatching(/another client holds this migration/i))
    expect(progressHandle.fail).toHaveBeenCalledWith(expect.stringMatching(/claim block/i))
  })

  it('says why a device that cannot take it is turning back', async () => {
    // Silence here reads as "nothing to do": the banner is already up, and the
    // operator has just consented to a migration.
    const {repo} = makeRepo(RAN, {
      refuseClaim: () => ({
        outcome: 'deferred', undoHistoryCleared: false, retryable: true,
        reason: 'this device is not caught up with the server',
      }),
    })
    planSynthesis.mockResolvedValue(plan(2))

    await invoke(repo)

    expect(applySynthesis).not.toHaveBeenCalled()
    expect(progressHandle.fail).toHaveBeenCalledWith(
      expect.stringMatching(/not caught up with the server.*Nothing was changed/is))
  })

  it('keeps the flip inside the claimed region, so a failed flip still releases', async () => {
    // The flip is the fleet-wide, one-way step. Outside the claim it would be
    // the second write a rival device could make concurrently; inside it, a
    // flip that throws still ends the gesture through the release.
    const log: ClaimStubLog = {events: []}
    const {repo, runPass} = makeRepo(RAN, {log})
    flipWorkspace.mockRejectedValue(
      Object.assign(new Error('the server refused'), {flipLanded: false}))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await invoke(repo)

    expect(log.events).toEqual(['claim', 'release'])
    expect(runPass).not.toHaveBeenCalled()
    expect(progressHandle.fail).toHaveBeenCalledWith(
      expect.stringMatching(/could not switch this workspace/i))
  })
})

describe('the stored-cell-value gate', () => {
  it('refuses the flip when a stored value no codec will carry exists', async () => {
    // The cell-level twin of the orphan-key refusal, and the reason it has to
    // be one: the key IS registered, so `audit-properties` reports the
    // workspace clean while these cells can never become child-backed — and
    // the flip they would be stranded by is one-way.
    cellValuesBlocked.mockReturnValue('2 property value(s) cannot be stored as property blocks')
    const {repo, runPass} = makeRepo()

    await invoke(repo)

    expect(showInfo).toHaveBeenCalledWith(
      expect.stringMatching(/cannot be stored as property blocks/), expect.anything())
    expect(openDialog).not.toHaveBeenCalled()
    expect(flipWorkspace).not.toHaveBeenCalled()
    expect(runPass).not.toHaveBeenCalled()
  })

  it('lets an already-flipped workspace run anyway, as an advisory', async () => {
    // Same bargain as the orphan-key gate: past the flip nothing irreversible
    // is left, and refusing would withhold the backfill from every other key
    // over a handful that can never migrate.
    cellValuesBlocked.mockReturnValue('2 property value(s) cannot be stored as property blocks')
    const {repo, runPass} = makeRepo(RAN, {flipped: true})

    await invoke(repo)

    expect(showInfo).toHaveBeenCalledWith(
      expect.stringMatching(/cannot be stored as property blocks/), expect.anything())
    expect(runPass).toHaveBeenCalled()
  })

  it('refuses the flip when a bad cell arrives while the dialog is open', async () => {
    // The pre-dialog survey is taken across a user-length pause. A sync
    // arrival or a raw write landing in it would otherwise be carried straight
    // into the one-way flip, after which that cell is stranded for good —
    // exactly the hazard the gate exists for, through the one window the
    // pre-dialog answer cannot see.
    cellValuesBlocked.mockReturnValueOnce(null)
      .mockReturnValue('1 property value(s) cannot be stored as property blocks')
    const {repo, runPass} = makeRepo()

    await invoke(repo)

    expect(openDialog).toHaveBeenCalled()
    expect(flipWorkspace).not.toHaveBeenCalled()
    expect(runPass).not.toHaveBeenCalled()
    expect(progressHandle.fail).toHaveBeenCalledWith(
      expect.stringMatching(/stopped before switching this workspace over/i))
    // And it refuses ABOVE the history drop, which is a POSITION this pins
    // rather than a second effect: a drop begun and then returned past is
    // never ended, and an unended one refuses every replay in the workspace
    // until the page reloads.
    expect(beginHistoryDrop).not.toHaveBeenCalled()
  })

  it('still catches a workspace switched DURING the pre-flip re-survey', async () => {
    // The re-survey is a paginated walk of every property bag, so it is a
    // multi-second suspension point — and dropped BELOW the active-workspace
    // check it would reopen the exact window that check exists to close, with
    // the flip the next thing to run. It sits above it instead, which costs a
    // wasted scan on this path and keeps the check the LAST thing before the
    // flip. A third check is what that check's own comment refuses.
    const {repo, runPass} = makeRepo()
    surveyCells.mockResolvedValueOnce({keys: [], cells: 0, blocksScanned: 7})
      .mockImplementation(async () => {
        ;(repo as unknown as {activeWorkspaceId: string}).activeWorkspaceId = 'ws-2'
        return {keys: [], cells: 0, blocksScanned: 7}
      })

    await invoke(repo)

    expect(flipWorkspace).not.toHaveBeenCalled()
    expect(runPass).not.toHaveBeenCalled()
    expect(progressHandle.fail).toHaveBeenCalledWith(
      expect.stringMatching(/different workspace is open now/i))
  })

  it('re-surveys under the claim, not against the pre-dialog snapshot', async () => {
    // Two calls, the second of them the one that guards the flip. One call
    // means the gate is a snapshot taken before the user had answered.
    const {repo} = makeRepo()

    await invoke(repo)

    expect(surveyCells).toHaveBeenCalledTimes(2)
  })

  it('does not make an already-flipped workspace pay for the re-survey', async () => {
    // There is no irreversible step left on that path, so the second scan
    // would be a full walk of every property bag bought for nothing.
    const {repo, runPass} = makeRepo(RAN, {flipped: true})

    await invoke(repo)

    expect(surveyCells).toHaveBeenCalledTimes(1)
    expect(runPass).toHaveBeenCalled()
  })

  it('fails closed when the pre-flip re-survey THROWS', async () => {
    // A read that threw says nothing about whether the precondition holds, and
    // this is the last thing between here and a one-way step.
    surveyCells.mockResolvedValueOnce({keys: [], cells: 0, blocksScanned: 7})
      .mockRejectedValue(new Error('the read failed'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const {repo, runPass} = makeRepo()

    await invoke(repo)

    expect(flipWorkspace).not.toHaveBeenCalled()
    expect(runPass).not.toHaveBeenCalled()
    expect(progressHandle.fail).toHaveBeenCalledWith(
      expect.stringMatching(/could not re-check/i))
  })

  it('does not survey the cells of a workspace the key gate already refused', async () => {
    // Ordering, and it is the expensive half: the survey decodes every stored
    // property value in the workspace, on the UI thread, before a dialog the
    // gesture is about to decline to show.
    flipBlocked.mockReturnValue('2 property key(s) cannot be given a definition')
    const {repo} = makeRepo()

    await invoke(repo)

    expect(surveyCells).not.toHaveBeenCalled()
  })

  it('takes the cell-value advisory down once a re-run comes back clean', async () => {
    // Sticky and stable-id like the synthesis one, and for the same reason: a
    // repaired workspace must not keep a "cannot migrate" banner through a
    // migration that then succeeds.
    const {repo} = makeRepo(RAN, {flipped: true})
    cellValuesBlocked.mockReturnValue('2 property value(s) cannot be stored as property blocks')
    await invoke(repo)
    const advisory = (showInfo.mock.calls[0]![1] as {id: string}).id

    showInfo.mockReset()
    dismissToast.mockReset()
    cellValuesBlocked.mockReturnValue(null)
    await invoke(repo)

    expect(dismissToast).toHaveBeenCalledWith(advisory)
  })

  it('reports a survey that THREW without changing anything', async () => {
    // Database reads, and nothing else is watching this await. Left to throw it
    // would end the gesture with no outcome reported, over a flip that had not
    // happened.
    surveyCells.mockRejectedValue(new Error('the read failed'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const {repo, runPass} = makeRepo()

    await invoke(repo)

    expect(showInfo).toHaveBeenCalledWith(expect.stringMatching(/nothing was changed/i))
    expect(openDialog).not.toHaveBeenCalled()
    expect(flipWorkspace).not.toHaveBeenCalled()
    expect(runPass).not.toHaveBeenCalled()
  })

  it('shows the dialog the blocks the survey actually read', async () => {
    // The survey replaced a separate candidate COUNT that ran here, so its scan
    // is now the only thing that can answer "how many blocks". Reading it from
    // anywhere else would be a second full walk of every property bag.
    surveyCells.mockResolvedValue({keys: [], cells: 0, blocksScanned: 41})
    const {repo} = makeRepo()

    await invoke(repo)

    expect(openDialog).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({blockCount: 41}))
  })
})

describe('the orphan-definition step', () => {
  it('refuses the flip when a key can never have a definition, before anything is scanned', async () => {
    // The hard case: such a key makes "every cell key resolves a definition"
    // unsatisfiable forever, and the flip is one-way. Refusing after the flip
    // would be refusing after the damage.
    flipBlocked.mockReturnValue('2 property key(s) cannot be given a definition')
    const {repo, runPass} = makeRepo()

    await invoke(repo)

    expect(showInfo).toHaveBeenCalledWith(
      expect.stringMatching(/cannot be given a definition/), expect.anything())
    expect(surveyCells).not.toHaveBeenCalled()
    expect(openDialog).not.toHaveBeenCalled()
    expect(flipWorkspace).not.toHaveBeenCalled()
    expect(runPass).not.toHaveBeenCalled()
  })

  it('lets an already-flipped workspace run anyway, because there is nothing left to guard', async () => {
    // Withholding the backfill from every OTHER key over a handful that can
    // never migrate would be the worse trade — and no irreversible step
    // remains on this path.
    flipBlocked.mockReturnValue('2 property key(s) cannot be given a definition')
    const {repo, runPass} = makeRepo(
      RAN, {flipped: true})

    await invoke(repo)

    expect(runPass).toHaveBeenCalled()
  })

  it('says so when an already-flipped workspace has nothing to mint but real corruption', async () => {
    // No candidates means the post-synthesis report never runs, so without this
    // the unreadable-bag warning is computed and then dropped — a run that
    // reports plain success over rows it could not inspect.
    flipBlocked.mockReturnValue('3 block(s) have a property bag this device cannot read')
    const {repo, runPass} = makeRepo(
      RAN, {flipped: true})

    await invoke(repo)

    expect(showInfo).toHaveBeenCalledWith(
      expect.stringMatching(/cannot read/), expect.anything())
    expect(runPass).toHaveBeenCalled()
  })

  it('carries synthesis\u2019s undo clear into what it tells the operator', async () => {
    // The clear itself belongs to synthesis — its in-lock half is not reachable
    // from out here — so this gesture's job is to REPORT it. Reported off the
    // returned flag and not off `created`, which is the same question asked
    // twice and the place the two could drift.
    planSynthesis.mockResolvedValue(plan(1))
    applySynthesis.mockResolvedValue(synthesized({created: 1, undoHistoryCleared: true}))
    flipBlocked.mockReturnValueOnce(null).mockReturnValue('still orphaned')
    // Already flipped, so nothing downstream would clear it.
    const {repo} = makeRepo(RAN, {flipped: true})

    await invoke(repo)

    expect(progressHandle.done).toHaveBeenCalledWith(
      expect.stringMatching(/Undo history for this workspace was cleared/))
    // And the abort path says so, rather than leaving the operator to discover it.
    expect(showInfo).toHaveBeenCalledWith(
      expect.stringMatching(/still orphaned/), expect.anything())
  })

  it('says nothing about undo when synthesis reports it took nothing', async () => {
    // A run that only converged minted nothing and cost the user no history;
    // telling them it did is a false alarm about data they still have.
    planSynthesis.mockResolvedValue(plan(1))
    applySynthesis.mockResolvedValue(synthesized({created: 1, undoHistoryCleared: false}))
    const {repo} = makeRepo(RAN, {flipped: true})

    await invoke(repo)

    expect(progressHandle.done).not.toHaveBeenCalledWith(
      expect.stringMatching(/Undo history for this workspace was cleared/))
  })

  it('says the stack was cleared when it refuses the flip after writing', async () => {
    // The refusal ends the run with definitions already committed and the
    // history already gone; leaving that unsaid is the same lie the flip-failure
    // branch goes out of its way to avoid.
    planSynthesis.mockResolvedValue(plan(2))
    applySynthesis.mockResolvedValue(synthesized({
      created: 1, undoHistoryCleared: true,
      skipped: [{key: 'demo:orphan', reason: 'occupied'}]}))
    flipBlocked.mockReturnValueOnce(null).mockReturnValue('still orphaned')
    const {repo} = makeRepo()

    await invoke(repo)

    expect(progressHandle.fail).toHaveBeenCalledWith(
      expect.stringMatching(/Undo history for this workspace was cleared/))
  })

  it('does not announce a flip on a run where only synthesis wrote', async () => {
    // The two facts are separate: the flip makes the workspace child-backed for
    // everyone; clearing the stack follows from any write. Driving the flip
    // banner off the undo flag made an already-flipped run claim a flip.
    planSynthesis.mockResolvedValue(plan(1))
    applySynthesis.mockResolvedValue(synthesized({created: 1, undoHistoryCleared: true}))
    const {repo} = makeRepo(RAN, {flipped: true})

    await invoke(repo)

    expect(progressHandle.done).toHaveBeenCalledWith(
      expect.stringMatching(/Undo history for this workspace was cleared/))
    expect(progressHandle.done).not.toHaveBeenCalledWith(
      expect.stringMatching(/switched to property blocks/i))
  })

  it('refuses a non-owner before planning, since only the owner can ever flip', async () => {
    // The server trigger refuses everyone else, permanently. Without this an
    // editor runs the whole gesture, mints definitions that claim shared
    // property names, clears the workspace's undo history — and only then finds
    // out the flip was never available to them.
    const {repo, runPass} = makeRepo(
      RAN, {owner: 'someone-else'})

    await invoke(repo)

    expect(showInfo).toHaveBeenCalledWith(expect.stringMatching(/only the workspace owner/i))
    expect(planSynthesis).not.toHaveBeenCalled()
    expect(surveyCells).not.toHaveBeenCalled()
    expect(openDialog).not.toHaveBeenCalled()
    expect(flipWorkspace).not.toHaveBeenCalled()
    expect(runPass).not.toHaveBeenCalled()
  })

  it('re-checks ownership after the confirmation, which is a user-length pause', async () => {
    // Ownership can change out of band, or the change can simply reach this
    // replica during the dialog. It is re-taken because it lives in
    // `passIsUnfit`, which is re-taken — the whole point of putting it there.
    planSynthesis.mockResolvedValue(plan(2))
    const {repo, runPass, getOptional} = makeRepo()
    let reads = 0
    getOptional.mockImplementation(async (sql: string) => sql.includes('owner_user_id')
      ? {owner_user_id: ++reads === 1 ? USER : 'someone-else'}
      : {properties_migration: 'cell'})

    await invoke(repo)

    expect(applySynthesis).not.toHaveBeenCalled()
    expect(flipWorkspace).not.toHaveBeenCalled()
    expect(runPass).not.toHaveBeenCalled()
    expect(progressHandle.fail).toHaveBeenCalledWith(
      expect.stringMatching(/only the workspace owner/i))
  })

  it('lets a non-owner backfill a workspace that is already flipped', async () => {
    // Nothing on that path needs the server, so ownership is irrelevant there.
    const {repo, runPass} = makeRepo(
      RAN, {flipped: true, owner: 'someone-else'})

    await invoke(repo)

    expect(runPass).toHaveBeenCalled()
  })

  it('does not flip a workspace the operator has navigated away from', async () => {
    // Every check above the flip has an await after it — the fitness read, the
    // synthesis write. This gesture's standing rule is that it does not act on
    // a workspace that is no longer open, and the flip is the one step that
    // cannot be taken back.
    const {repo, runPass, workspaceViewGap} = makeRepo()
    // On the SECOND fitness read — the one after the confirmation — so the
    // switch lands past the post-dialog check and the flip is the next thing
    // that would act.
    let reads = 0
    workspaceViewGap.mockImplementation(async () => {
      if (++reads === 2) (repo as unknown as {activeWorkspaceId: string}).activeWorkspaceId = 'ws-2'
      return null
    })

    await invoke(repo)

    expect(flipWorkspace).not.toHaveBeenCalled()
    expect(runPass).not.toHaveBeenCalled()
    expect(progressHandle.fail).toHaveBeenCalledWith(
      expect.stringMatching(/different workspace is open now/i))
  })

  it('mints the missing definitions BEFORE it flips', async () => {
    // The §9 runbook order. A definition is a dormant block at 'cell', so
    // minting early is free; minting after the flip leaves a window in which
    // the pass skips those keys and reports success over them.
    planSynthesis.mockResolvedValue(plan(3))
    const {repo} = makeRepo()

    await invoke(repo)

    expect(applySynthesis).toHaveBeenCalled()
    expect(applySynthesis.mock.invocationCallOrder[0]!)
      .toBeLessThan(flipWorkspace.mock.invocationCallOrder[0]!)
  })

  it('does not claim nothing happened when the flip fails after minting definitions', async () => {
    // They are inert at 'cell' and a re-run reuses them, but they show up on
    // the Properties page, so "nothing was migrated" alone would be a small lie.
    planSynthesis.mockResolvedValue(plan(3))
    applySynthesis.mockResolvedValue(synthesized({created: 3, undoHistoryCleared: true}))
    flipWorkspace.mockRejectedValue(
      Object.assign(new Error('server said no'), {flipLanded: false}))
    const {repo} = makeRepo()

    await invoke(repo)

    expect(progressHandle.fail).toHaveBeenCalledWith(
      expect.stringMatching(/3 definition\(s\) added just before it are still there/))
    // …and that the history is gone, which is true in exactly this partial
    // outcome and was the one abort path not saying so.
    expect(progressHandle.fail).toHaveBeenCalledWith(
      expect.stringMatching(/Undo history for this workspace was cleared/))
  })

  it('does not flip when the definitions could not be minted', async () => {
    planSynthesis.mockResolvedValue(plan(3))
    applySynthesis.mockRejectedValue(new Error('nope'))
    const {repo, runPass} = makeRepo()

    await invoke(repo)

    expect(flipWorkspace).not.toHaveBeenCalled()
    expect(runPass).not.toHaveBeenCalled()
    expect(progressHandle.fail).toHaveBeenCalledWith(expect.stringMatching(/nothing was migrated/))
  })

  it('does not mint into a workspace the plan refused', async () => {
    // A device that cannot establish which namespace this workspace's definition
    // ids belong under. `flipBlockedBySynthesis` decides whether that stops the
    // gesture; what must not happen either way is writing anyway.
    planSynthesis.mockResolvedValue(
      {...plan(2), refusal: 'this device has not resolved whether the workspace is encrypted'})
    const {repo} = makeRepo(RAN, {flipped: true})

    await invoke(repo)

    expect(applySynthesis).not.toHaveBeenCalled()
    // And the dialog does not promise the minting it is about to skip.
    expect(openDialog).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({synthesizedKeys: {count: 0, names: []}}))
  })

  it('files keys a REFUSED device skips as stranded, not as impossible', async () => {
    // These are keys a definition could back — what the refusal says is that
    // this DEVICE will not mint one, which the operator can fix. Reported as
    // "cannot be given a definition at all" they read as permanent, which is
    // the `repairableKeys` mistake with a different cause.
    planSynthesis.mockResolvedValue(
      {...plan(2), refusal: 'this device holds no content key for the encrypted workspace'})
    const {repo} = makeRepo(RAN, {flipped: true})

    await invoke(repo)

    expect(openDialog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      unfixableKeys: {count: 0, names: []},
      stranded: {
        count: 2,
        names: ['demo:orphan0', 'demo:orphan1'],
        reason: 'this device holds no content key for the encrypted workspace',
      },
    }))
  })

  it('raises no stranded category when the refusal strands nothing', async () => {
    // A refused device whose keys all already have definitions. The refusal is
    // real — the flip still cannot happen here — but there is no key to name,
    // and a paragraph about "0 properties" is noise on a consent screen.
    planSynthesis.mockResolvedValue({...plan(0), refusal: 'this device has no local row'})
    const {repo} = makeRepo(RAN, {flipped: true})

    await invoke(repo)

    expect(openDialog).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({stranded: null}))
  })

  it('names the keys behind every count it shows, and caps what it hands over', async () => {
    // The whole point of the screen: it asks consent for a one-way, fleet-wide
    // change, and a bare count sends the operator to the CLI audit to find out
    // which keys — at the one moment they have no reason to go looking. Capped
    // at the construction site so a workspace with thousands of orphan keys
    // hands a React prop a handful of strings rather than a copy of the plan.
    planSynthesis.mockResolvedValue({
      ...plan(5),
      blockers: [{key: 'demo:hopeless', cells: 2, reason: 'reads as a block reference'}],
      brokenDefinitions: [{key: 'demo:broken', cells: 3}],
    })
    const {repo} = makeRepo(RAN, {flipped: true})

    await invoke(repo)

    expect(openDialog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      // Count exact, names a sample — so the copy can say how many it left out.
      synthesizedKeys: {
        count: 5, names: ['demo:orphan0', 'demo:orphan1', 'demo:orphan2'],
      },
      unfixableKeys: {count: 1, names: ['demo:hopeless']},
      repairableKeys: {count: 1, names: ['demo:broken']},
    }))
  })

  it('does not mint into a workspace the operator navigated away from', async () => {
    // The confirmation is a user-length pause. Minting past the re-check would
    // write definitions into the graph they just left — the same reason the
    // flip takes that check twice.
    planSynthesis.mockResolvedValue(plan(3))
    const {repo} = makeRepo()
    openDialog.mockImplementation(dialogThatSwitchesWorkspace(repo))

    await invoke(repo)

    expect(applySynthesis).not.toHaveBeenCalled()
  })

  it('tells the operator a broken definition is REPAIRABLE, not permanent', async () => {
    // On a one-way consent screen, calling a repairable problem permanent is
    // how the one cheap moment to repair it is missed. Usually it is just an
    // extension that is not enabled on this device.
    planSynthesis.mockResolvedValue({...plan(), brokenDefinitions: [{key: 'demo:b', cells: 3}]})
    const {repo} = makeRepo(RAN, {flipped: true})

    await invoke(repo)

    expect(openDialog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      repairableKeys: {count: 1, names: ['demo:b']},
      unfixableKeys: {count: 0, names: []},
    }))
  })

  it('does not flip when a key came back with no definition, even though minting succeeded', async () => {
    // The pre-mint gate said go; the OUTCOME says a key is still orphaned. The
    // backfill excludes unregistered keys from its work list, so without the
    // second ask the flip lands and the pass reports success over it.
    planSynthesis.mockResolvedValue(plan(2))
    applySynthesis.mockResolvedValue(synthesized({
      created: 1, undoHistoryCleared: true,
      skipped: [{key: 'demo:orphan', reason: 'occupied'}]}))
    flipBlocked.mockReturnValueOnce(null).mockReturnValue('still have no definition')
    const {repo, runPass} = makeRepo()

    await invoke(repo)

    expect(flipWorkspace).not.toHaveBeenCalled()
    expect(runPass).not.toHaveBeenCalled()
    expect(progressHandle.fail).toHaveBeenCalledWith(expect.stringMatching(/still have no definition/))
  })

  it('backfills anyway on an already-flipped workspace, and says what was left out', async () => {
    planSynthesis.mockResolvedValue(plan(2))
    applySynthesis.mockResolvedValue(synthesized({
      created: 1, undoHistoryCleared: true,
      skipped: [{key: 'demo:orphan', reason: 'occupied'}]}))
    flipBlocked.mockReturnValueOnce(null).mockReturnValue('still have no definition')
    const {repo, runPass} = makeRepo(RAN, {flipped: true})

    await invoke(repo)

    expect(runPass).toHaveBeenCalled()
    expect(showInfo).toHaveBeenCalledWith(
      expect.stringMatching(/still have no definition/), expect.anything())
  })

  it('takes the fitness check BEFORE minting, so "nothing was changed" stays true', async () => {
    // Below the synthesis block this message is false the moment a definition
    // commits — the same lie the flip-failure branch goes out of its way to
    // avoid one step later.
    planSynthesis.mockResolvedValue(plan(3))
    const {repo, workspaceViewGap} = makeRepo()
    // Clean at the pre-dialog check, behind by the time the operator confirms —
    // the window that makes the SECOND check the load-bearing one.
    let gapChecks = 0
    workspaceViewGap.mockImplementation(
      async () => gapChecks++ === 0 ? null : DRAINING)

    await invoke(repo)

    expect(applySynthesis).not.toHaveBeenCalled()
    expect(progressHandle.fail).toHaveBeenCalledWith(
      expect.stringMatching(/Nothing was changed/))
  })

  it('stops without writing when the plan itself cannot be built', async () => {
    planSynthesis.mockRejectedValue(new Error('registry is not loaded'))
    const {repo, runPass} = makeRepo()

    await invoke(repo)

    expect(showInfo).toHaveBeenCalledWith(expect.stringMatching(/registry is not loaded/))
    expect(openDialog).not.toHaveBeenCalled()
    expect(flipWorkspace).not.toHaveBeenCalled()
    expect(runPass).not.toHaveBeenCalled()
  })
})

describe('what a completed run tells the operator', () => {
  it('calls a run that migrated nothing a failure, not a green "0 blocks"', async () => {
    // Failures are per-value by design, so a run where every value was refused
    // otherwise came back as a success banner reading "Migrated properties on
    // 0 blocks."
    const {message, failed} = describeOutcome(
      RAN, counts(0, {unmigrated: 12}))

    expect(failed).toBe(true)
    expect(message).toMatch(/Nothing was migrated/i)
    expect(message).toMatch(/12/)
  })

  it('does not tell the operator WHY nothing migrated, having no way to know', async () => {
    // It used to call this "a systematic problem, not a handful of bad
    // values". Nothing available here separates a broken first run from a
    // converged graph whose only remaining cells are permanently undecodable:
    // both write nothing and refuse the same count. On a real migrated graph
    // the second is the steady state, so the diagnosis was wrong on every
    // re-run, forever.
    const {message} = describeOutcome(
      RAN, counts(0, {unmigrated: 65}))

    expect(message).not.toMatch(/systematic/i)
  })

  it('does not report the stop condition over cells it never attempted', async () => {
    // The runbook is "re-run until it reports nothing left". An unregistered
    // key is skipped without raising a failure, so a run whose only remaining
    // cells are those wrote nothing and refused nothing — indistinguishable,
    // here, from a finished one. It reported the stop condition, and the
    // operator stops on that sentence with the values still unmigrated.
    const {message, failed} = describeOutcome(
      RAN, counts(0, {unresolved: 12, unresolvedNames: ['a-key']}))

    expect(failed).toBe(true)
    expect(message).not.toMatch(/nothing left to migrate/i)
    expect(message).toMatch(/no registered schema/i)
    expect(message).toMatch(/12/)
  })

  it('names the skipped keys after a run that DID migrate values', async () => {
    // Not only on the ending that moved nothing: a run can migrate a thousand
    // values and still skip a key whose plugin is disabled, and that key is
    // then the only thing left to act on. Both repairs land in ONE worklist —
    // they share a toast id, so a second note would replace the first.
    const {followUp} = describeOutcome(
      RAN, counts(5, {unmigrated: 2, unresolved: 3, unresolvedNames: ['a-key', 'b-key']}))

    expect(followUp).toMatch(/could not be migrated/i)
    expect(followUp).toMatch(/no registered schema/i)
    expect(followUp).toMatch(/a-key/)
    expect(followUp).toMatch(/b-key/)
  })

  it('reports a run that found nothing left as such, not as work it did', async () => {
    // The runbook's stop condition is "re-run until it reports nothing left",
    // and a block count cannot carry it — a finished workspace once rendered
    // as "Migrated properties on 249 blocks", live numbers from the report.
    //
    // The input pairs a nonzero block count with zero values ON PURPOSE. The
    // run-wide counters cannot now produce it (the owner set only grows when
    // a value moves), so this is defence in depth: it fails if either the
    // branch or the message is ever re-pointed at the block count.
    const {message, failed} = describeOutcome(
      RAN, counts(249, {valuesMaterializedTotal: 0}))

    expect(failed).toBe(false)
    expect(message).toMatch(/nothing left to migrate/i)
    // The count is the whole defect: reporting it here is what made a finished
    // migration read exactly like one starting over.
    expect(message).not.toMatch(/249/)
  })

  it('does not claim the undo history for a re-run that wrote nothing', async () => {
    // The runner only drops the stack for a batch that WROTE, so a no-op
    // re-run comes back with `undoHistoryCleared: false` — and the banner must
    // not charge the operator for a cost that was not taken.
    const {repo} = makeRepo({outcome: 'ran', undoHistoryCleared: false}, {flipped: true})

    await invoke(repo)

    expect(progressHandle.fail).not.toHaveBeenCalled()
    expect(progressHandle.done).toHaveBeenCalledWith(
      expect.stringMatching(/nothing left to migrate/i))
    expect(progressHandle.done).toHaveBeenCalledWith(
      expect.not.stringMatching(/undo history/i))
  })

  it('is not "systematic" when one bad key per block hid a mostly-good run', async () => {
    // A run that moved 40 values off 20 owners and refused 20 more is a
    // mostly-good run, not a failure. Branching on a per-block "accepted in
    // full" count called it one, because one bad key per block reads as zero
    // accepted while tens of thousands of rows moved.
    const {failed} = describeOutcome(
      RAN, counts(20, {valuesMaterializedTotal: 40, unmigrated: 20}),
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
      const {message} = describeOutcome(result, counts(0), {flipped: true, undoCleared: true})
      expect(message, result.outcome).toMatch(/switched to property blocks/i)
      expect(message, result.outcome).not.toMatch(/not started/i)
    }
  })

  it('says nothing about a flip on a workspace that was already past it', async () => {
    // The un-flipped runs are the only ones that owe that sentence; adding it to
    // every run would tell an operator their gesture did something it did not.
    expect(describeOutcome(
      {outcome: 'deferred', undoHistoryCleared: false, reason: 'busy'},
      counts(0), {flipped: false, undoCleared: false},
    ).message).not.toMatch(/switched to property blocks/i)
  })

})

describe('a deferral the operator cannot clear by waiting', () => {
  it('does not tell them to run it again, even once the flip has landed', async () => {
    // Past the flip every outcome reports with the undo stack already cleared,
    // which used to pick the "run it again" sentence unconditionally. A
    // durable view gap and a workspace turned read-only both arrive here, and
    // both are exactly what `retryable: false` exists to stop being retried
    // forever.
    const {message} = describeOutcome(
      {outcome: 'deferred', undoHistoryCleared: true,
       reason: '3 synced row(s) have not reached `blocks`', retryable: false},
      counts(0), {flipped: true, undoCleared: true},
    )

    expect(message).toMatch(/will not get further/i)
    expect(message).not.toMatch(/run it again/i)
  })

  it('still says to run it again when waiting IS the remedy', async () => {
    const {message} = describeOutcome(
      {outcome: 'deferred', undoHistoryCleared: true,
       reason: 'synced rows are still draining', retryable: true},
      counts(0), {flipped: true, undoCleared: true},
    )

    expect(message).toMatch(/run it again/i)
  })
})

describe('every outcome says whether the history is gone', () => {
  // The sentence is appended once at the wrapper, so this walks the whole
  // outcome union rather than the branch that happened to be reported.
  const outcomes: OperatorBackfillResult[] = [
    RAN,
    {outcome: 'deferred', undoHistoryCleared: false, reason: 'a reason'},
    {outcome: 'failed', undoHistoryCleared: false, reason: 'a reason'},
    {outcome: 'held-by-peer', undoHistoryCleared: false},
    {outcome: 'already-running', undoHistoryCleared: false},
    {outcome: 'read-only', undoHistoryCleared: false},
    {outcome: 'not-found', undoHistoryCleared: false},
  ]

  it('appends the undo notice to every outcome once the stack has been cleared', () => {
    for (const result of outcomes) {
      const {message} = describeOutcome(result, counts(0), {flipped: false, undoCleared: true})
      expect(message, result.outcome).toMatch(/Undo history for this workspace was cleared/)
    }
  })

  it('says nothing about undo when nothing cleared it', () => {
    for (const result of outcomes) {
      const {message} = describeOutcome(result, counts(0), {flipped: false, undoCleared: false})
      expect(message, result.outcome).not.toMatch(/Undo history/)
    }
  })

  it('covers the all-values-failed branch, which returns before the common tail', () => {
    const {message} = describeOutcome(
      RAN,
      counts(0, {unmigrated: 5}),
      {flipped: false, undoCleared: true})
    expect(message).toMatch(/all 5 property value\(s\) the pass tried/)
    expect(message).toMatch(/Undo history for this workspace was cleared/)
  })
})

describe('what an aborted run tells the operator', () => {
  it('does not say "Not started" for a run that wrote and dropped the undo stack', async () => {
    // The per-transaction preconditions abort MID-run, and on a connected
    // device that is the expected ending — after a large part of the graph is
    // already written.
    const {message} = describeOutcome(
      {outcome: 'deferred', undoHistoryCleared: true, reason: 'synced rows are still draining'},
      counts(0),
    )

    expect(message).not.toMatch(/not started/i)
    expect(message).toMatch(/undo history/i)
  })

  it('tells a failed run its undo history is gone too', async () => {
    const {message} = describeOutcome(
      {outcome: 'failed', undoHistoryCleared: true, reason: 'the pass gave up.'}, counts(0),
    )

    expect(message).toMatch(/undo history/i)
  })
})
