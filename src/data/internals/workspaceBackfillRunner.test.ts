// @vitest-environment node

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { workspaceBackfillsFacet, type WorkspaceBackfill } from '@/data/facets'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'

/** Properties of the shared `WorkspaceBackfill` runner, independent of any one
 *  backfill: when it is allowed to run, and what its writes are allowed to do
 *  to the user's undo stack. */

const WS = 'ws-backfill-runner'
const OTHER_WS = 'ws-backfill-runner-other'

let sharedDb: TestDb

/** A backfill that records its runs and writes one block, so the tx it used is
 *  observable through undo. */
const probeBackfill = (runs: string[]): WorkspaceBackfill => ({
  id: 'probe-backfill-v1',
  trigger: 'workspace-open',
  run: async ({workspaceId, tx}) => {
    runs.push(workspaceId)
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
  }, 20_000)

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
        tryClaim: async (_ws, id) => { claimAttempts.push(id); return true },
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
        tryClaim: async (_ws, id) => { if (claimed.has(id)) return false; claimed.add(id); return true },
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
        tryClaim: async (_ws, id) => { claimAttempts.push(id); return true },
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
      reason: 'this device is not caught up with the server '
        + '(still downloading, disconnected, or a download error)',
    })
    expect(claimAttempts).toEqual([])
    expect(runs).toEqual([])
  })

  it('reports failure, not success, when the pass throws', async () => {
    // Reporting "ran" for a pass that died tells the operator the migration is
    // done when it is not, and costs them the retry.
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      backfillCompletionClaim: {
        tryClaim: async () => true,
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
        tryClaim: async () => true,
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
