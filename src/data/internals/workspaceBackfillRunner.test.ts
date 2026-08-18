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
  await vi.runAllTimersAsync()
  await repo.awaitWorkspaceBackfills()
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

  it('releases the claim when a run aborts, so it is not blocked forever', async () => {
    // A claimed-but-unfinished pass must hand the claim back: otherwise one
    // device's transient bad moment blocks the migration for the whole graph.
    const g = controllableGate()
    const released: string[] = []
    const claimed = new Set<string>()
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      backfillSyncGate: g.gate,
      backfillCompletionClaim: {
        tryClaim: async (_ws, id) => { if (claimed.has(id)) return false; claimed.add(id); return true },
        markComplete: async () => {},
        releaseClaim: async (_ws, id) => { released.push(id); claimed.delete(id) },
      },
    })
    repo.setActiveWorkspaceId(WS)
    repo.setRuntimeContributions(workspaceBackfillsFacet, 'test-backfills', [probeBackfill([])])
    await seedTarget(repo)
    await sharedDb.db.execute(
      "INSERT INTO blocks_synced_changes (id, op) VALUES ('draining', 'upsert')",
    )

    g.open()
    await drain(repo)

    // The invariant is that the claim is HANDED BACK, not how many times.
    // `PendingIdleJobs.schedule` does not coalesce, so a second arming of the
    // gate runs the pass again — each run claims, aborts and releases — and
    // asserting an exact call count made this test order-dependent (green in a
    // full-file run, red when filtered). A repeated release is harmless here:
    // the stub re-claims first, so the sequence stays claim/release balanced,
    // which is what `claimed.size` pins.
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
    // The pass fires ~10-30s after workspace open, i.e. while the user is
    // already editing. As its own entry it would be TOP of the stack, so their
    // next cmd-Z reverts the backfill instead of their own edit — and the
    // marker is recorded, so it never comes back.
    const runs: string[] = []
    const repo = makeRepo(probeBackfill(runs))
    await seedTarget(repo)
    // The user edits a DIFFERENT block, so their entry doesn't overlap the
    // backfill's row — the ordinary case, and the one this fix is for.
    await repo.tx(async tx => {
      await tx.create({id: 'elsewhere', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'before'})
    }, {scope: ChangeScope.BlockDefault, description: 'seed elsewhere'})
    await repo.tx(async tx => {
      await tx.update('elsewhere', {content: 'user edit'})
    }, {scope: ChangeScope.BlockDefault, description: 'user edit'})

    await drain(repo)
    expect(runs).toEqual([WS])
    expect((await repo.load('target'))?.properties['probe:mark']).toBe('backfilled')

    await repo.undo(ChangeScope.BlockDefault)

    // cmd-Z landed on the user's edit, and the backfill's write survived.
    expect((await repo.load('elsewhere'))?.content).toBe('before')
    expect((await repo.load('target'))?.properties['probe:mark']).toBe('backfilled')
  })

  it('is still reverted by an undo entry that already covers the same row', async () => {
    // KNOWN LIMITATION, recorded rather than hidden. Undo replay restores an
    // entry's whole `before` row snapshot, not a field delta — so when the user
    // edited the very row a later backfill touches, their cmd-Z takes the
    // backfill's write with it, and the completion marker makes that permanent.
    // `skipUndo` cannot fix this: the damage comes from the USER's entry, which
    // must stay undoable. Pre-existing — before `skipUndo` the same cmd-Z
    // reverted the backfill directly, as its own top-of-stack entry. Closing it
    // means rebasing or invalidating overlapping history, which is undo-internals
    // surgery and a separate decision.
    const repo = makeRepo(probeBackfill([]))
    await seedTarget(repo)
    await repo.tx(async tx => {
      await tx.update('target', {content: 'user edit'})
    }, {scope: ChangeScope.BlockDefault, description: 'user edit'})

    await drain(repo)
    expect((await repo.load('target'))?.properties['probe:mark']).toBe('backfilled')

    await repo.undo(ChangeScope.BlockDefault)

    expect((await repo.load('target'))?.content).toBe('original')
    expect((await repo.load('target'))?.properties['probe:mark']).toBeUndefined()
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

describe('workspace backfill runner — registry readiness', () => {
  it('defers rather than completing vacuously when the registry is not primed', async () => {
    // The hazard: an unprimed registry answers "no such property" for EVERY
    // name, so a pass finds no candidates, writes nothing, opens no
    // transaction — and then records a PERMANENT per-graph completion. The
    // migration reads as done, on every device, forever, having migrated
    // nothing.
    const runs: string[] = []
    const backfill: WorkspaceBackfill = {
      id: 'needs-registry-v1',
      run: async ({workspaceId}) => { runs.push(workspaceId) },
    }
    const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
    repo.setActiveWorkspaceId(WS)
    repo.setRuntimeContributions(workspaceBackfillsFacet, 'test-backfills', [backfill])
    // No `projectedPropertyDefinitionsFacet` contribution → no registry.

    repo.scheduleWorkspaceBackfills(WS)
    await vi.runAllTimersAsync()
    await repo.awaitWorkspaceBackfills()

    expect(runs).toEqual([])
  })
})
