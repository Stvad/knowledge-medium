// @vitest-environment node

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { workspaceBackfillsFacet, type WorkspaceBackfill } from '@/data/facets'
import { Repo, type OperatorBackfillResult } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { BLOCKS_SYNCED_RAW_TABLE, blockToSyncedRowParams } from '@/data/blockSchema'
import { createTestRepo } from '@/data/test/createTestRepo'
import { DeterministicIdCrossWorkspaceError } from '@/data/api/errors'

/** Properties of the shared `WorkspaceBackfill` runner, independent of any one
 *  backfill: when it is allowed to run, and what its writes are allowed to do
 *  to the user's undo stack. */

const WS = 'ws-backfill-runner'
const OTHER_WS = 'ws-backfill-runner-other'

let sharedDb: TestDb

/** A backfill that records its runs and writes one block, so the tx it used is
 *  observable through undo. */
const probeBackfill = (
  runs: string[],
  /** Runs after the pass has started and before its write — the window where a
   *  precondition the gate already cleared can stop holding. */
  beforeWrite?: () => Promise<void>,
): WorkspaceBackfill => ({
  id: 'probe-backfill-v1',
  trigger: 'workspace-open',
  run: async ({workspaceId, tx}) => {
    runs.push(workspaceId)
    await beforeWrite?.()
    const targetId = workspaceId === WS ? 'target' : `target-${workspaceId}`
    await tx(async t => {
      const row = await t.get(targetId)
      if (!row) return
      await t.update(targetId, {properties: {...row.properties, 'probe:mark': 'backfilled'}})
    }, {description: 'probe backfill write'})
  },
})

const makeRepo = (
  backfill: WorkspaceBackfill,
  gate?: (cb: () => void) => () => void,
): Repo => {
  const {repo} = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    ...(gate ? {backfillSyncGate: gate} : {}),
  })
  repo.setActiveWorkspaceId(WS)
  repo.setRuntimeContributions(workspaceBackfillsFacet, 'test-backfills', [backfill])
  return repo
}

const seedTarget = async (repo: Repo): Promise<void> => {
  await repo.tx(async tx => {
    await tx.create({id: 'target', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'original'})
  }, {scope: ChangeScope.BlockDefault, description: 'seed'})
}

const drain = async (repo: Repo): Promise<void> => {
  repo.scheduleWorkspaceBackfills(WS)
  // ONE pass. Most tests here park the gate and assert on exactly what that
  // pass did, so draining further would run work they are asserting has not
  // happened. A test that needs the runner to reach a settled state drives
  // its own condition — see `settleUntil`.
  await vi.runAllTimersAsync()
  await repo.awaitWorkspaceBackfills()
}

/** Keep driving the runner until `done()` holds.
 *
 *  `awaitWorkspaceBackfills` can return while work is still in flight: it
 *  does not see a continuation that schedules ITS timer several awaits later,
 *  so the barrier resolves and an assertion reads half-finished state. Wait on
 *  the outcome instead of on the barrier. Bounded to fail rather than hang;
 *  the bound is a livelock guard, not the definition of settled. */
const settleUntil = async (repo: Repo, done: () => boolean): Promise<void> => {
  for (let i = 0; i < 20 && !done(); i++) {
    await vi.runAllTimersAsync()
    await repo.awaitWorkspaceBackfills()
  }
}

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db); vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('workspace backfill runner — sync gating', () => {
  /** A gate with the real contract: fires SYNCHRONOUSLY when already settled,
   *  otherwise parks the callback until `open()`. The synchronous-when-settled
   *  half is load-bearing — `assertBackfillMayWrite` probes with a throwaway
   *  gate before every transaction and reads "fired synchronously" as "still
   *  settled". */
  const controllableGate = () => {
    let settled = false
    let waiters: (() => void)[] = []
    return {
      gate: (cb: () => void) => {
        if (settled) { cb(); return () => {} }
        waiters.push(cb)
        return () => { waiters = waiters.filter(w => w !== cb) }
      },
      open: () => {
        settled = true
        const pending = waiters
        waiters = []
        for (const w of pending) w()
      },
      close: () => { settled = false },
      /** Callbacks still parked — i.e. listeners a real gate would be holding. */
      armed: () => waiters.length,
    }
  }

  it('does not run while the device is still catching up', async () => {
    // The hazard is not just "misses rows". `apply_block_patches` assigns
    // `properties_json` wholesale, so a write built from a stale local row
    // uploads the whole stale bag and drops property edits made elsewhere that
    // haven't arrived. A half-synced device must not write at all.
    const runs: string[] = []
    const g = controllableGate()
    const repo = makeRepo(probeBackfill(runs), g.gate)
    await seedTarget(repo)

    await drain(repo)
    expect(runs).toEqual([])

    // Catch-up completes; the armed gate opens and the pass runs.
    g.open()
    await vi.runAllTimersAsync()
    await repo.awaitWorkspaceBackfills()
    expect(runs).toEqual([WS])
  })

  it('aborts mid-run when the device falls behind between batches', async () => {
    // The check is per-TRANSACTION now, not once before the run. A chunked pass
    // writes over minutes, so a single pre-run check only ever covered the
    // first batch — this pins the batches after it.
    const g = controllableGate()
    const batches: number[] = []
    const chunked: WorkspaceBackfill = {
      id: 'chunked-probe-v1',
      trigger: 'workspace-open',
      run: async ({tx}) => {
        for (let i = 0; i < 3; i++) {
          if (i === 1) g.close()          // a fresh download starts mid-run
          await tx(async () => { batches.push(i) }, {description: `batch ${i}`})
        }
      },
    }
    const repo = makeRepo(chunked, g.gate)
    await seedTarget(repo)

    g.open()
    await drain(repo)

    // First batch ran; the second aborted the pass rather than writing stale.
    expect(batches).toEqual([0])
    const markers = await sharedDb.db.getAll<{key: string}>(
      "SELECT key FROM client_schema_state WHERE key LIKE 'workspace_backfill:%'",
    )
    expect(markers).toEqual([])   // no marker → next open retries
  })

  it('aborts mid-run when the user leaves the workspace between batches', async () => {
    const g = controllableGate()
    const batches: number[] = []
    const chunked: WorkspaceBackfill = {
      id: 'chunked-probe-v1',
      trigger: 'workspace-open',
      run: async ({tx}) => {
        for (let i = 0; i < 3; i++) {
          if (i === 1) repo.setActiveWorkspaceId(OTHER_WS)
          await tx(async () => { batches.push(i) }, {description: `batch ${i}`})
        }
      },
    }
    const repo = makeRepo(chunked, g.gate)
    await seedTarget(repo)

    g.open()
    await drain(repo)

    expect(batches).toEqual([0])
  })

  it('aborts a job scheduled during an earlier visit to the same workspace', async () => {
    // A -> B -> A. Comparing workspace IDs alone accepts the first visit's job
    // once the user returns, but that is a different open with a different
    // registry and access state.
    const g = controllableGate()
    const runs: string[] = []
    const repo = makeRepo(probeBackfill(runs), g.gate)
    await seedTarget(repo)

    repo.scheduleWorkspaceBackfills(WS)
    g.open()                              // visit 1's job is queued
    repo.setActiveWorkspaceId(OTHER_WS)
    repo.setActiveWorkspaceId(WS)         // back again — same id, new generation
    await vi.runAllTimersAsync()
    await repo.awaitWorkspaceBackfills()

    expect(runs).toEqual([])
  })

  it('aborts mid-run when rows start staging between batches', async () => {
    // The pre-run check catches a graph that is already draining; this pins the
    // PER-TRANSACTION one, which is the only thing covering staging that starts
    // after a chunked pass has begun.
    const g = controllableGate()
    const batches: number[] = []
    const chunked: WorkspaceBackfill = {
      id: 'chunked-staging-v1',
      trigger: 'workspace-open',
      run: async ({tx}) => {
        for (let i = 0; i < 3; i++) {
          if (i === 1) {
            await sharedDb.db.execute(
              "INSERT INTO blocks_synced_changes (id, op) VALUES ('late-row', 'upsert')",
            )
          }
          await tx(async () => { batches.push(i) }, {description: `batch ${i}`})
        }
      },
    }
    const repo = makeRepo(chunked, g.gate)
    await seedTarget(repo)

    g.open()
    await drain(repo)

    expect(batches).toEqual([0])
    const markers = await sharedDb.db.getAll<{key: string}>(
      "SELECT key FROM client_schema_state WHERE key LIKE 'workspace_backfill:%'",
    )
    expect(markers).toEqual([])
  })

  it('records no marker for a run that found nothing while rows were still staged', async () => {
    // The per-transaction check only fires when a pass WRITES. A pass that
    // finds no candidates is exactly what a partially materialized graph looks
    // like — the rows are staged, not yet in `blocks` — so without a check
    // around the run itself it would record its one-shot marker as done.
    const g = controllableGate()
    const ran: string[] = []
    const findsNothing: WorkspaceBackfill = {
      id: 'finds-nothing-v1',
      trigger: 'workspace-open',
      run: async ({workspaceId}) => { ran.push(workspaceId) },   // never calls tx
    }
    const repo = makeRepo(findsNothing, g.gate)
    await seedTarget(repo)
    await sharedDb.db.execute(
      "INSERT INTO blocks_synced_changes (id, op) VALUES ('pending-row', 'upsert')",
    )

    g.open()
    await drain(repo)

    expect(ran).toEqual([])
    const markers = await sharedDb.db.getAll<{key: string}>(
      "SELECT key FROM client_schema_state WHERE key LIKE 'workspace_backfill:%'",
    )
    expect(markers).toEqual([])
  })

  it('records no marker when rows stage after the pass’s last write', async () => {
    // The narrow window the other two checks miss: pre-run passed, every
    // transaction passed, and staging begins before completion is claimed.
    // Recording the marker there would call a run over a graph that had gone
    // stale mid-pass "done", permanently.
    const g = controllableGate()
    const late: WorkspaceBackfill = {
      id: 'stages-after-write-v1',
      trigger: 'workspace-open',
      run: async ({tx}) => {
        await tx(async () => {}, {description: 'the only batch'})
        await sharedDb.db.execute(
          "INSERT INTO blocks_synced_changes (id, op) VALUES ('after-write', 'upsert')",
        )
      },
    }
    const repo = makeRepo(late, g.gate)
    await seedTarget(repo)

    g.open()
    await drain(repo)

    const markers = await sharedDb.db.getAll<{key: string}>(
      "SELECT key FROM client_schema_state WHERE key LIKE 'workspace_backfill:%'",
    )
    expect(markers).toEqual([])
  })

  it('retries once a transient abort clears, rather than giving up for the session', async () => {
    // The aborts are momentary by construction — the download finishes, the
    // queue drains. Logging and walking away would leave the pass undone for
    // the whole session even though its blocker was seconds long.
    const g = controllableGate()
    const runs: string[] = []
    const repo = makeRepo(probeBackfill(runs), g.gate)
    await seedTarget(repo)
    await sharedDb.db.execute(
      "INSERT INTO blocks_synced_changes (id, op) VALUES ('draining', 'upsert')",
    )

    g.open()
    await drain(repo)
    expect(runs).toEqual([])                       // aborted: rows still staging

    // The queue drains; the re-armed pass goes through without another open.
    await sharedDb.db.execute('DELETE FROM blocks_synced_changes')
    await vi.runAllTimersAsync()
    await repo.awaitWorkspaceBackfills()

    expect(runs).toEqual([WS])
    expect((await repo.load('target'))?.properties['probe:mark']).toBe('backfilled')
  })

  it('defers a pass whose workspace holds rows that were downloaded and never materialized', async () => {
    // Distinct from the draining case above, and the reason the pre-claim gate
    // asks the WORKSPACE-scoped predicate: the drain has already passed over
    // this row and consumed its queue entry, so nothing is in flight and no
    // waiting changes that — while the pass would claim, scan a graph it can
    // only partly see, and upload from it.
    const runs: string[] = []
    const repo = makeRepo(probeBackfill(runs))
    await seedTarget(repo)
    repo.stopSyncObserver()
    await sharedDb.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToSyncedRowParams({
      id: 'never-materialized', workspaceId: WS, parentId: null, orderKey: 'z0',
      content: 'downloaded, never decoded', properties: {}, references: [],
      createdAt: 1, updatedAt: 5, userUpdatedAt: 5, createdBy: 'u', updatedBy: 'u',
      deleted: false,
    }))
    await sharedDb.db.execute('DELETE FROM blocks_synced_changes')

    // Spied before `drain`, which schedules once itself — so a second call
    // would be the runner re-arming.
    const scheduled = vi.spyOn(repo, 'scheduleWorkspaceBackfills')

    await drain(repo)
    expect(runs).toEqual([])
    // NO re-arm, unlike the transient deferrals above. `arm()` fires its
    // callback synchronously once the device is caught up, so re-arming on a
    // gap nothing is going to clear means this full scan every deep-idle tick
    // for the rest of the session.
    expect(scheduled).toHaveBeenCalledTimes(1)

    // The positive control, and it is the real recovery gesture: re-run
    // materialization — what a reload or a re-entered workspace key does — and
    // the pass goes through. Without it this test would pass just as well
    // against a runner that never started at all.
    repo.startSyncObserver()
    await repo.drainSyncWorkspace(WS)
    repo.scheduleWorkspaceBackfills(WS)
    await settleUntil(repo, () => runs.length > 0)
    expect(runs).toContain(WS)
  })

  it('aborts a batch once a delivery is left unapplied after the pass started', async () => {
    // A pass runs for minutes. A row that becomes unappliable AFTER the
    // pre-claim gate — an evicted key, a delivery that will not decode — is
    // deferred and its queue entry consumed, so anything that only watches work
    // in flight reads clear again for every batch that follows. The flag the
    // drain left on the staging row does not, and the per-transaction check is
    // the SAME predicate the gate took, not a cheaper stand-in for it.
    const runs: string[] = []
    const repo = makeRepo(probeBackfill(runs, async () => {
      // Between the gate and the write, which is the window under test.
      await sharedDb.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToSyncedRowParams({
        id: 'undecodable', workspaceId: WS, parentId: null, orderKey: 'z0',
        content: 'arrived mid-pass, could not be applied', properties: {}, references: [],
        createdAt: 1, updatedAt: 5, userUpdatedAt: 5, createdBy: 'u', updatedBy: 'u',
        deleted: false,
      }))
      await sharedDb.db.execute('DELETE FROM blocks_synced_changes')
    }))
    await seedTarget(repo)
    repo.stopSyncObserver()

    await drain(repo)

    expect(runs).toEqual([WS])                       // it started
    expect((await repo.load('target'))?.properties['probe:mark']).toBeUndefined()
  })

  it('defers per DEVICE, not per backfill', async () => {
    // The gap is a property of the device, so every remaining pass would defer
    // identically — and `arm()` only de-dupes a PARKED gate, which this path's
    // is not (it is settled by construction). Continuing the loop instead of
    // returning therefore schedules N jobs, each of which re-runs all N
    // passes, and the deferrals multiply.
    //
    // Asserted on the DISTINCT ids that deferred, not on a count: how many
    // idle cycles one drain gets through is load-dependent, and extra cycles
    // only repeat the same id — but one-deferral-per-backfill names all three.
    const deferred = new Set<string>()
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args) => {
      const m = /"([^"]+)" deferred/.exec(args.map(String).join(' '))
      if (m) deferred.add(m[1]!)
    })
    try {
      const g = controllableGate()
      const repo = makeRepo(probeBackfill([]), g.gate)
      repo.setRuntimeContributions(workspaceBackfillsFacet, 'test-backfills',
        Array.from({length: 3}, (_, i) => ({
          ...probeBackfill([]), id: `probe-backfill-v${i + 1}`,
        })))
      await seedTarget(repo)
      await sharedDb.db.execute(
        "INSERT INTO blocks_synced_changes (id, op) VALUES ('draining', 'upsert')",
      )

      g.open()
      await drain(repo)

      expect([...deferred]).toEqual(['probe-backfill-v1'])
    } finally {
      warn.mockRestore()
    }
    // 52ms measured solo — no explicit budget, because at the ~6x p99.9
    // stretch a full gate run adds that is still an order of magnitude under
    // vitest's 5000ms default. A budget here would only delay reporting a
    // genuine hang, which is exactly what this test would catch: un-gating the
    // re-arm turns the loop into a runaway.
  })

  it('takes no claim at all while rows are staged, because tryClaim itself writes', async () => {
    // `tryClaim` ensures the Migrations page and creates the claim row, so
    // reaching it from a stale view queues a create AND the tombstone of its
    // release — on reconnect the create can conflict with an unseen server
    // completion while the tombstone frees later operators to repeat the
    // migration. The gate has to sample BOTH ways of being behind, not just
    // whether the device is caught up.
    const g = controllableGate()
    const claimAttempts: string[] = []
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      backfillSyncGate: g.gate,
      backfillCompletionClaim: {
        tryClaim: async (_ws, id) => { claimAttempts.push(id); return 'minted' as const },
        markComplete: async () => {},
        releaseClaim: async () => {},
      },
    })
    repo.setActiveWorkspaceId(WS)
    const runs: string[] = []
    repo.setRuntimeContributions(workspaceBackfillsFacet, 'test-backfills', [probeBackfill(runs)])
    await seedTarget(repo)
    await sharedDb.db.execute(
      "INSERT INTO blocks_synced_changes (id, op) VALUES ('draining', 'upsert')",
    )

    g.open()
    await drain(repo)

    expect(claimAttempts).toEqual([])
    expect(runs).toEqual([])
  })

  it('releases the claim when a run aborts, so it is not blocked forever', async () => {
    // A claimed-but-unfinished pass must hand the claim back: otherwise one
    // device's transient bad moment blocks the migration for the whole graph.
    const g = controllableGate()
    const released: string[] = []
    /** Releases with no claim behind them. Recorded rather than ignored: on a
     *  synced once-per-graph claim, an unmatched release frees a claim another
     *  runner holds. */
    const unheldReleases: string[] = []
    const claimed = new Set<string>()
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      backfillSyncGate: g.gate,
      backfillCompletionClaim: {
        tryClaim: async (_ws, id) => {
          if (claimed.has(id)) return 'declined' as const
          claimed.add(id)
          return 'minted' as const
        },
        markComplete: async () => {},
        releaseClaim: async (_ws, id) => {
          if (!claimed.has(id)) { unheldReleases.push(id); return }
          released.push(id)
          claimed.delete(id)
        },
      },
    })
    repo.setActiveWorkspaceId(WS)
    // Staged AFTER the claim, from inside the run: rows staged up front no
    // longer reach `tryClaim` at all (see the test above), so a pass that
    // aborts while HOLDING a claim is the only shape that still exercises the
    // hand-back this test exists for.
    repo.setRuntimeContributions(workspaceBackfillsFacet, 'test-backfills', [{
      id: 'probe-backfill-v1',
      trigger: 'workspace-open' as const,
      run: async ({tx}) => {
        await sharedDb.db.execute(
          "INSERT INTO blocks_synced_changes (id, op) VALUES ('late-row', 'upsert')",
        )
        await tx(async () => {}, {description: 'batch after staging began'})
      },
    }])
    await seedTarget(repo)

    g.open()
    await drain(repo)
    await settleUntil(repo, () => released.length > 0 && claimed.size === 0)

    // The invariant is that every claim is handed BACK — balance, not a call
    // count. `PendingIdleJobs.schedule` does not coalesce, so the pass can be
    // armed more than once and each arming legitimately claims, aborts and
    // releases; an exact count asserts scheduling, not the contract. A release
    // with NO claim behind it is the real defect — on a synced once-per-graph
    // claim it frees one another runner holds.
    expect(unheldReleases).toEqual([])
    expect(released).toContain('probe-backfill-v1')
    expect(claimed.size).toBe(0)
  })

  it('refuses every backfill when no completion claim is configured', async () => {
    // Production has no synced claim store yet. Falling back to the local
    // marker would have each device attempt an upload-carrying repair
    // independently — the stale-write hazard itself — so the runner refuses.
    const runs: string[] = []
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => { errors.push(String(m)) })
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      backfillSyncGate: (cb) => { cb(); return () => {} },
      backfillCompletionClaim: undefined as never,   // explicit: none configured
    })
    repo.setActiveWorkspaceId(WS)
    repo.setRuntimeContributions(workspaceBackfillsFacet, 'test-backfills', [probeBackfill(runs)])
    await seedTarget(repo)

    await drain(repo)

    expect(runs).toEqual([])
    expect(errors.join(' ')).toContain('no BackfillCompletionClaim is configured')
  })

  it('disposes a gate still armed for a workspace the user left', async () => {
    // Listener hygiene, distinct from the per-transaction checks above: a gate
    // still PARKED holds a status listener and captures the departed workspace
    // id. `scheduleWorkspaceBackfills` only disposes a stale gate when it is
    // reached again, which the read-only / no-backfills early returns skip
    // entirely — so the leaving path must.
    const g = controllableGate()
    const repo = makeRepo(probeBackfill([]), g.gate)
    await seedTarget(repo)

    repo.scheduleWorkspaceBackfills(WS)   // arms, never opens
    expect(g.armed()).toBe(1)

    repo.setActiveWorkspaceId('ws-somewhere-else')

    expect(g.armed()).toBe(0)
  })

  it('records no completion marker while gated, so the next open retries', async () => {
    // The marker is the thing that makes a premature run permanent.
    const runs: string[] = []
    const repo = makeRepo(probeBackfill(runs), () => () => {})
    await seedTarget(repo)

    await drain(repo)

    const markers = await sharedDb.db.getAll<{key: string}>(
      "SELECT key FROM client_schema_state WHERE key LIKE 'workspace_backfill:%'",
    )
    expect(markers).toEqual([])
  })
})

describe('workspace backfill runner — undo', () => {
  it('keeps its writes off the user’s undo stack', async () => {
    // The pass fires while the user is already editing. As its own entry it
    // would be TOP of the stack, so their next cmd-Z reverts the backfill
    // instead of their own edit — and the marker is recorded, so it never
    // comes back. `skipUndo` is what keeps it off; this asserts nothing the
    // pass wrote is reachable by undo afterwards.
    const runs: string[] = []
    const repo = makeRepo(probeBackfill(runs))
    await seedTarget(repo)
    await repo.tx(async tx => {
      await tx.create({id: 'elsewhere', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'before'})
    }, {scope: ChangeScope.BlockDefault, description: 'seed elsewhere'})

    await drain(repo)
    expect(runs).toEqual([WS])
    expect((await repo.load('target'))?.properties['probe:mark']).toBe('backfilled')

    await repo.undo(ChangeScope.BlockDefault)

    expect((await repo.load('target'))?.properties['probe:mark']).toBe('backfilled')
  })

  it('clears the undo history it would otherwise be reverted by', async () => {
    // Undo replay restores an entry's whole `before` row snapshot, not a field
    // delta — so an entry recorded BEFORE the pass, for a row the pass then
    // rewrote, takes the migration's write with it when the user hits cmd-Z
    // for their own edit, permanently (completion is already recorded).
    // `skipUndo` cannot reach that entry: the damage comes from the USER's,
    // which is legitimately undoable. So the pass drops the stack instead —
    // the entries at risk are exactly the ones unsafe to replay.
    const repo = makeRepo(probeBackfill([]))
    await seedTarget(repo)
    await repo.tx(async tx => {
      await tx.update('target', {content: 'user edit'})
    }, {scope: ChangeScope.BlockDefault, description: 'user edit'})

    await drain(repo)
    expect((await repo.load('target'))?.properties['probe:mark']).toBe('backfilled')

    await repo.undo(ChangeScope.BlockDefault)

    // Nothing to undo: the user's edit stands and the migration survives.
    expect((await repo.load('target'))?.content).toBe('user edit')
    expect((await repo.load('target'))?.properties['probe:mark']).toBe('backfilled')
  })

  it('clears the stack with the FIRST batch, not when the whole pass returns', async () => {
    // A chunked pass runs for minutes. Clearing at the end leaves every one of
    // those minutes as a window in which cmd-Z replays a pre-pass row snapshot
    // over a batch that has already committed — and the pass then records
    // completion over the reverted rows.
    let depthAfterFirstBatch = -1
    const repo = makeRepo({
      id: 'probe-backfill-v1',
      trigger: 'workspace-open' as const,
      run: async ({tx}) => {
        await tx(async t => { await t.update('target', {content: 'batch one'}) },
          {description: 'batch one'})
        depthAfterFirstBatch = repo.undoManager.depths(ChangeScope.BlockDefault).undo
        await tx(async t => { await t.update('target', {content: 'batch two'}) },
          {description: 'batch two'})
      },
    })
    await seedTarget(repo)
    await repo.tx(async tx => {
      await tx.update('target', {content: 'user edit'})
    }, {scope: ChangeScope.BlockDefault, description: 'user edit'})
    expect(repo.undoManager.depths(ChangeScope.BlockDefault).undo).toBeGreaterThan(0)

    await drain(repo)

    expect(depthAfterFirstBatch).toBe(0)
  })

  it('leaves undo history alone when the pass writes nothing', async () => {
    // Clearing is a real cost to the user, so it is owed only when the pass
    // actually committed something that history could be replayed over.
    const repo = makeRepo({
      id: 'probe-backfill-v1',
      trigger: 'workspace-open' as const,
      run: async () => {},
    })
    await seedTarget(repo)
    await repo.tx(async tx => {
      await tx.update('target', {content: 'user edit'})
    }, {scope: ChangeScope.BlockDefault, description: 'user edit'})

    await drain(repo)
    await repo.undo(ChangeScope.BlockDefault)

    expect((await repo.load('target'))?.content).toBe('original')
  })

  it('still uploads — suppressing undo must not make it a local-only write', async () => {
    // The whole point of a WorkspaceBackfill over a raw db.execute is that its
    // writes reach the server (the daily-note:date bug).
    const repo = makeRepo(probeBackfill([]))
    await seedTarget(repo)
    await sharedDb.db.execute('DELETE FROM ps_crud')

    await drain(repo)

    const ops = (await sharedDb.db.getAll<{data: string}>('SELECT data FROM ps_crud'))
      .map(r => JSON.parse(r.data) as {id: string})
      .filter(e => e.id === 'target')
    expect(ops.length).toBeGreaterThan(0)
  })
})

describe('workspace backfill runner — operator trigger', () => {
  const operatorBackfill = (runs: string[]): WorkspaceBackfill => ({
    id: 'operator-probe-v1',
    trigger: 'operator',
    run: async ({workspaceId}) => { runs.push(workspaceId) },
  })

  it('is never started by opening the workspace', async () => {
    // The whole basis of exactly-once for a once-per-graph pass: nothing
    // automatic starts it, so two devices opening the same workspace cannot
    // both begin uploading source-of-truth rows.
    const runs: string[] = []
    const repo = makeRepo(operatorBackfill(runs))
    await seedTarget(repo)

    await drain(repo)

    expect(runs).toEqual([])
  })

  it('runs when an operator asks, and reports what happened', async () => {
    const runs: string[] = []
    const repo = makeRepo(operatorBackfill(runs))
    await seedTarget(repo)

    expect((await repo.runWorkspaceBackfillNow(WS, 'operator-probe-v1')).outcome).toBe('ran')
    expect(runs).toEqual([WS])
  })

  it('refuses an id that is not an operator pass, rather than running the wrong thing', async () => {
    const runs: string[] = []
    const repo = makeRepo(probeBackfill(runs))
    await seedTarget(repo)

    // `probe-backfill-v1` is `workspace-open`; asking for it by name must not
    // hand the operator an automatic pass through the manual door.
    expect((await repo.runWorkspaceBackfillNow(WS, 'probe-backfill-v1')).outcome).toBe('not-found')
    expect((await repo.runWorkspaceBackfillNow(WS, 'no-such-pass')).outcome).toBe('not-found')
    expect(runs).toEqual([])
  })
})

describe('workspace backfill runner — operator outcomes', () => {
  it('does not claim while this device is behind the server', async () => {
    // `tryClaim` WRITES (the Migrations page, then the claim row). Claiming
    // first and discovering staleness inside the pass leaves both that create
    // and its release queued — on reconnect they can tombstone a completion
    // this device never saw, freeing later operators to repeat the migration.
    const runs: string[] = []
    const claimAttempts: string[] = []
    // A gate that never fires = this device is behind and stays behind.
    const neverSettles = () => () => {}
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      backfillSyncGate: neverSettles,
      backfillCompletionClaim: {
        tryClaim: async (_ws, id) => { claimAttempts.push(id); return 'minted' as const },
        markComplete: async () => {},
        releaseClaim: async () => {},
      },
    })
    repo.setActiveWorkspaceId(WS)
    repo.setRuntimeContributions(workspaceBackfillsFacet, 'test-backfills', [{
      id: 'operator-sync-v1',
      trigger: 'operator' as const,
      run: async ({workspaceId}) => { runs.push(workspaceId) },
    }])
    await seedTarget(repo)

    // `deferred`, not `held-by-peer`: the two call for opposite
    // responses, and an operator told "already done" here would stop retrying
    // a migration that has not started.
    expect(await repo.runWorkspaceBackfillNow(WS, 'operator-sync-v1')).toEqual({
      outcome: 'deferred',
      undoHistoryCleared: false,
      // Waiting IS the remedy for every deferral here; only a durable view gap
      // reports false, and an operator is told so instead of "try again".
      retryable: true,
      reason: 'this device is not caught up with the server '
        + '(still downloading, disconnected, or a download error)',
    })
    expect(claimAttempts).toEqual([])
    expect(runs).toEqual([])
  })

  // Records attempts so these can assert the runner never reached the claim.
  const recordingClaim = (attempts: string[]) => ({
    tryClaim: async (_ws: string, id: string) => { attempts.push(id); return 'minted' as const },
    markComplete: async () => {},
    releaseClaim: async () => {},
  })

  const staleRunRepo = (attempts: string[], id: string) => {
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      backfillCompletionClaim: recordingClaim(attempts),
    })
    repo.setActiveWorkspaceId(WS)
    repo.setRuntimeContributions(workspaceBackfillsFacet, 'test-backfills', [{
      id,
      trigger: 'operator' as const,
      run: async () => {},
    }])
    return repo
  }

  it('does not claim into a workspace the user has left', async () => {
    // `tryClaim` WRITES. A re-arm carrying a departed workspace id reaches it
    // with a MATCHING generation — `scheduleWorkspaceBackfills` captures the
    // generation when it is called, not when the run was scheduled — and the
    // registry check admits it too, since it accepts the previous workspace.
    const attempts: string[] = []
    const repo = staleRunRepo(attempts, 'departed-ws-v1')
    await seedTarget(repo)

    expect(await repo.runWorkspaceBackfillNow('ws-departed', 'departed-ws-v1')).toEqual({
      outcome: 'deferred',
      undoHistoryCleared: false,
      retryable: true,
      reason: expect.stringContaining('no longer active'),
    })
    expect(attempts).toEqual([])
  })

  it('does not claim when the workspace changes while the sync check is in flight', async () => {
    // The check before the gap cannot cover this: `syncViewGap` awaits.
    const attempts: string[] = []
    const repo = staleRunRepo(attempts, 'switch-midflight-v1')
    await seedTarget(repo)
    const realGap = repo.syncViewGap.bind(repo)
    vi.spyOn(repo, 'syncViewGap').mockImplementation(async () => {
      const gap = await realGap()
      repo.setActiveWorkspaceId('ws-elsewhere')
      return gap
    })

    expect(await repo.runWorkspaceBackfillNow(WS, 'switch-midflight-v1')).toEqual({
      outcome: 'deferred',
      undoHistoryCleared: false,
      retryable: true,
      reason: expect.stringContaining('no longer active'),
    })
    expect(attempts).toEqual([])
  })

  it('does not claim when the workspace is re-opened while the sync check is in flight', async () => {
    // A -> B -> A restores the id, so an identity-only check passes while the
    // run still belongs to the EARLIER visit. The generation tells them apart.
    const attempts: string[] = []
    const repo = staleRunRepo(attempts, 'reopen-midflight-v1')
    await seedTarget(repo)
    const realGap = repo.syncViewGap.bind(repo)
    vi.spyOn(repo, 'syncViewGap').mockImplementation(async () => {
      const gap = await realGap()
      repo.setActiveWorkspaceId('ws-elsewhere')
      repo.setActiveWorkspaceId(WS)
      return gap
    })

    expect(await repo.runWorkspaceBackfillNow(WS, 'reopen-midflight-v1')).toEqual({
      outcome: 'deferred',
      undoHistoryCleared: false,
      retryable: true,
      reason: expect.stringContaining('re-opened'),
    })
    expect(attempts).toEqual([])
  })

  it('reports failure, not success, when the pass throws', async () => {
    // Reporting "ran" for a pass that died tells the operator the migration is
    // done when it is not, and costs them the retry.
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      backfillCompletionClaim: {
        tryClaim: async () => 'minted' as const,
        markComplete: async () => {},
        releaseClaim: async () => {},
      },
    })
    repo.setActiveWorkspaceId(WS)
    repo.setRuntimeContributions(workspaceBackfillsFacet, 'test-backfills', [{
      id: 'operator-throws-v1',
      trigger: 'operator' as const,
      run: async () => { throw new Error('pass exploded') },
    }])
    await seedTarget(repo)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    // `failed`, not `held-by-peer`: a pass that threw may have
    // committed some batches, and the operator is the only one who can decide
    // to re-run. Told "already done", they never learn it is incomplete.
    const result = await repo.runWorkspaceBackfillNow(WS, 'operator-throws-v1')
    expect(result.outcome).toBe('failed')
    expect(result.reason).toMatch(/pass exploded/i)
  })
})

describe('workspace backfill runner — concurrent operator invocations', () => {
  it('single-flights the same pass instead of running it twice', async () => {
    // Two invocations in one Repo share a claimant, so the claim reads the
    // second as the same owner and would let it proceed. Then either one
    // aborting releases the claim they SHARE while the other still writes,
    // and the survivor's markComplete stamps a tombstone — completion goes
    // invisible and the next operator repeats the migration.
    let release!: () => void
    const started: string[] = []
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      backfillCompletionClaim: {
        tryClaim: async () => 'minted' as const,
        markComplete: async () => {},
        releaseClaim: async () => {},
      },
    })
    repo.setActiveWorkspaceId(WS)
    repo.setRuntimeContributions(workspaceBackfillsFacet, 'test-backfills', [{
      id: 'operator-slow-v1',
      trigger: 'operator' as const,
      run: async ({workspaceId}) => {
        started.push(workspaceId)
        await new Promise<void>(resolve => { release = resolve })
      },
    }])
    await seedTarget(repo)

    const first = repo.runWorkspaceBackfillNow(WS, 'operator-slow-v1')
    await vi.waitFor(() => { expect(started).toHaveLength(1) })

    // Second invocation while the first is still inside `run`.
    expect((await repo.runWorkspaceBackfillNow(WS, 'operator-slow-v1')).outcome).toBe('already-running')
    expect(started).toHaveLength(1)

    release()
    expect((await first).outcome).toBe('ran')
  })
})

/**
 * `withOperatorBackfillClaim` — a gesture whose steps BEFORE the pass also
 * write source-of-truth rows (the properties migration synthesizes definition
 * blocks and flips the workspace), so it has to hold the graph-wide claim
 * across all of them rather than take it inside the pass.
 */
describe('workspace backfill runner — a claim held across a gesture', () => {
  /** Records the claim seam's calls in order, so a test can assert the claim
   *  came before the body rather than merely that both happened. */
  const spyClaim = (events: string[], {won = true}: {won?: boolean} = {}) => ({
    // A win MINTS. `inherited` is a separate axis with its own test below —
    // folding it in here would silence every release assertion at once.
    tryClaim: async () => { events.push('tryClaim'); return won ? 'minted' as const : 'declined' as const },
    markComplete: async () => { events.push('markComplete') },
    releaseClaim: async () => { events.push('releaseClaim') },
  })

  const gestureRepo = (events: string[], backfill: WorkspaceBackfill, won = true): Repo => {
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      backfillCompletionClaim: spyClaim(events, {won}),
    })
    repo.setActiveWorkspaceId(WS)
    repo.setRuntimeContributions(workspaceBackfillsFacet, 'test-backfills', [backfill])
    return repo
  }

  const noopPass = (runs: string[] = []): WorkspaceBackfill => ({
    id: 'gesture-v1',
    trigger: 'operator' as const,
    run: async ({workspaceId}) => { runs.push(workspaceId) },
  })

  it('takes the claim before the body writes anything, and hands it back after', async () => {
    const events: string[] = []
    const repo = gestureRepo(events, noopPass())
    await seedTarget(repo)

    const outcome = await repo.withOperatorBackfillClaim(WS, 'gesture-v1', async pass => {
      events.push('body-writes')
      await pass.run()
    })

    expect(outcome).toEqual({claimed: true})
    // The pass re-asks: a peer's claim can sync in during the body, and
    // `tryClaim` on a claim we still hold is a read that answers `proceed`
    // without writing. What matters here is the FIRST one, before the body.
    expect(events).toEqual([
      'tryClaim', 'body-writes', 'tryClaim', 'markComplete', 'releaseClaim',
    ])
  })

  it('does not let the body run at all when a peer holds the claim', async () => {
    // The regression this method exists for. Told "held by a peer" AFTER
    // synthesizing, a device has already published its own definitions.
    const events: string[] = []
    const bodies: string[] = []
    const repo = gestureRepo(events, noopPass(), false)
    await seedTarget(repo)

    const outcome = await repo.withOperatorBackfillClaim(WS, 'gesture-v1', async () => {
      bodies.push('ran')
    })

    expect(bodies).toEqual([])
    expect(outcome).toEqual({
      claimed: false,
      result: {outcome: 'held-by-peer', undoHistoryCleared: false},
    })
    // Nothing to hand back — releasing a claim this device never won would
    // take it from the peer that does hold it.
    expect(events).toEqual(['tryClaim'])
  })

  it('hands the claim back when the body throws', async () => {
    // A body that dies partway has to release, or one device's bad moment
    // blocks the pass for the whole graph until a human deletes the block.
    const events: string[] = []
    const repo = gestureRepo(events, noopPass())
    await seedTarget(repo)

    await expect(repo.withOperatorBackfillClaim(WS, 'gesture-v1', async () => {
      throw new Error('synthesis exploded')
    })).rejects.toThrow(/synthesis exploded/)

    expect(events).toEqual(['tryClaim', 'releaseClaim'])
  })

  it('still reports `claimed` for a body that refused and never ran the pass', async () => {
    // The migration's own shape: several branches report their own refusal and
    // return before reaching `pass.run()` — a flip the server declined, a
    // definition that could not be minted. Those are still CLAIMED runs, and
    // the caller keys its own reporting off that: `claimed: false` would have
    // the action print a second, contradictory outcome over the one the body
    // just showed.
    const events: string[] = []
    const repo = gestureRepo(events, noopPass())
    await seedTarget(repo)

    const outcome = await repo.withOperatorBackfillClaim(WS, 'gesture-v1', async () => {})

    expect(outcome).toEqual({claimed: true, value: undefined})
    expect(events).toEqual(['tryClaim', 'releaseClaim'])
  })

  it('never releases a claim it only inherited from a sibling tab', async () => {
    // Two tabs of one browser profile share a claimant id, and the
    // single-flight set is per-Repo — so the second tab's `tryClaim` reads the
    // first tab's LIVE claim as its own and succeeds without writing. Released
    // on the way out, that deletes a claim the sibling is still writing under,
    // and a third device is then free to start the same source-of-truth pass.
    // Running on it is the accepted overlap; releasing it is not.
    const events: string[] = []
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      backfillCompletionClaim: {
        tryClaim: async () => { events.push('tryClaim'); return 'inherited' as const },
        markComplete: async () => { events.push('markComplete') },
        releaseClaim: async () => { events.push('releaseClaim') },
      },
    })
    repo.setActiveWorkspaceId(WS)
    repo.setRuntimeContributions(workspaceBackfillsFacet, 'test-backfills', [noopPass()])
    await seedTarget(repo)

    // A body that refuses and returns early — the shape that reaches the
    // `finally` without the pass having recorded anything.
    const outcome = await repo.withOperatorBackfillClaim(WS, 'gesture-v1', async () => {})

    expect(outcome).toEqual({claimed: true, value: undefined})
    expect(events).toEqual(['tryClaim'])
    expect(events).not.toContain('releaseClaim')
  })

  it('still runs the pass on an inherited claim — the overlap is tolerated, the delete is not', async () => {
    // The other half: inheriting must not turn into a refusal. These passes
    // are idempotent per row, which is what makes a two-tab overlap
    // acceptable; only the release is the hazard.
    const events: string[] = []
    const runs: string[] = []
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      backfillCompletionClaim: {
        tryClaim: async () => { events.push('tryClaim'); return 'inherited' as const },
        markComplete: async () => { events.push('markComplete') },
        releaseClaim: async () => { events.push('releaseClaim') },
      },
    })
    repo.setActiveWorkspaceId(WS)
    repo.setRuntimeContributions(workspaceBackfillsFacet, 'test-backfills', [noopPass(runs)])
    await seedTarget(repo)

    const result = await repo.runWorkspaceBackfillNow(WS, 'gesture-v1')

    expect(result.outcome).toBe('ran')
    expect(runs).toEqual([WS])
    expect(events).not.toContain('releaseClaim')
  })

  it('does not let a failing pass hand back the claim the gesture still holds', async () => {
    // The pass releases on its own failure paths — correct when the pass IS
    // the gesture, wrong here: the body keeps running after `pass.run()`
    // returns, and a release from inside it would leave those steps unclaimed.
    // One owner, one release.
    const events: string[] = []
    const repo = gestureRepo(events, {
      id: 'gesture-v1',
      trigger: 'operator' as const,
      run: async () => { throw new Error('pass exploded') },
    })
    await seedTarget(repo)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    let outcome: OperatorBackfillResult | null = null
    await repo.withOperatorBackfillClaim(WS, 'gesture-v1', async pass => {
      outcome = await pass.run()
      events.push('body-continues')
    })

    expect(outcome).toMatchObject({outcome: 'failed'})
    // Exactly one release, and it lands AFTER the body is done.
    expect(events).toEqual(['tryClaim', 'tryClaim', 'body-continues', 'releaseClaim'])
  })

  it('does not claim, or run the body, while this device is behind the server', async () => {
    // `tryClaim` WRITES. The gate that protected the pass has to protect the
    // gesture too, or the claim moves in front of it.
    const events: string[] = []
    const bodies: string[] = []
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      backfillSyncGate: () => () => {},
      backfillCompletionClaim: spyClaim(events),
    })
    repo.setActiveWorkspaceId(WS)
    repo.setRuntimeContributions(workspaceBackfillsFacet, 'test-backfills', [noopPass()])
    await seedTarget(repo)

    const outcome = await repo.withOperatorBackfillClaim(WS, 'gesture-v1', async () => {
      bodies.push('ran')
    })

    expect(bodies).toEqual([])
    expect(events).toEqual([])
    expect(outcome).toEqual({
      claimed: false,
      result: {
        outcome: 'deferred',
        undoHistoryCleared: false,
        retryable: true,
        reason: 'this device is not caught up with the server '
          + '(still downloading, disconnected, or a download error)',
      },
    })
  })

  it('does not tell the operator to wait out a claim error that waiting cannot clear', async () => {
    // A foreign block parked at the deterministic claim id needs someone to
    // move it. Reported as retryable, the palette says "try again shortly"
    // and the operator retries a gesture that will refuse identically forever.
    const bodies: string[] = []
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      backfillCompletionClaim: {
        tryClaim: async () => {
          throw new DeterministicIdCrossWorkspaceError('claim-id', 'ws-other', WS)
        },
        markComplete: async () => {},
        releaseClaim: async () => {},
      },
    })
    repo.setActiveWorkspaceId(WS)
    repo.setRuntimeContributions(workspaceBackfillsFacet, 'test-backfills', [noopPass()])
    await seedTarget(repo)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const outcome = await repo.withOperatorBackfillClaim(WS, 'gesture-v1', async () => {
      bodies.push('ran')
    })

    expect(bodies).toEqual([])
    expect(outcome).toMatchObject({claimed: false, result: {retryable: false}})
  })

  it('single-flights the whole gesture, not just the pass', async () => {
    // Two invocations in one Repo share a claimant, so the claim reads the
    // second as the same owner. Stopped only at the pass, the second would
    // have synthesized and flipped first.
    const events: string[] = []
    const bodies: string[] = []
    const repo = gestureRepo(events, noopPass())
    await seedTarget(repo)
    let release!: () => void

    const first = repo.withOperatorBackfillClaim(WS, 'gesture-v1', async () => {
      bodies.push('first')
      await new Promise<void>(resolve => { release = resolve })
    })
    await vi.waitFor(() => { expect(bodies).toHaveLength(1) })

    expect(await repo.withOperatorBackfillClaim(WS, 'gesture-v1', async () => {
      bodies.push('second')
    })).toEqual({
      claimed: false,
      result: {outcome: 'already-running', undoHistoryCleared: false},
    })
    expect(bodies).toEqual(['first'])

    release()
    await first
  })

  it('defers without releasing when the claim write throws, rather than running the body', async () => {
    const events: string[] = []
    const bodies: string[] = []
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      backfillCompletionClaim: {
        tryClaim: async () => { throw new Error('claim write failed') },
        markComplete: async () => {},
        releaseClaim: async () => { events.push('releaseClaim') },
      },
    })
    repo.setActiveWorkspaceId(WS)
    repo.setRuntimeContributions(workspaceBackfillsFacet, 'test-backfills', [noopPass()])
    await seedTarget(repo)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const outcome = await repo.withOperatorBackfillClaim(WS, 'gesture-v1', async () => {
      bodies.push('ran')
    })

    expect(bodies).toEqual([])
    // NOT released. A throw does not prove the row is unwritten, but
    // `releaseClaim` cannot tell this device's half-written claim from a
    // SIBLING TAB's live one — `claimantId` is per browser profile, so both
    // name this claimant. Deleting a live claim frees a second device to start
    // an uploading pass while the first tab is still writing; a claim this
    // device may have stranded is recoverable by deleting the block.
    expect(events).toEqual([])
    // `deferred`, not `failed`: nothing started, and "stopped partway" would
    // send an operator looking for half-migrated data.
    expect(outcome).toEqual({
      claimed: false,
      result: {
        outcome: 'deferred', undoHistoryCleared: false,
        reason: 'claim write failed', retryable: true,
      },
    })
  })
})
