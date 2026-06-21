// @vitest-environment node
/**
 * Built-in consistency audit (L3 of the data-integrity defense). Covers the
 * Repo idle-job wiring (schedule → run → metric, cadence gating) and that the
 * audit's mirror check actually catches an injected inconsistency. The check SQL
 * itself lives in src/data/internals/consistencyAudit.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import {
  AT_REST_ANOMALY_FLOOR,
  runConsistencyAudit,
  type AuditDb,
} from '@/data/internals/consistencyAudit'
import { Repo } from '../repo'

interface Harness {
  repo: Repo
  cleanup: () => Promise<void>
}

const setup = (db: TestDb['db']): Harness => {
  const repo = new Repo({ db, cache: new BlockCache(), user: { id: 'user-1' } })
  return { repo, cleanup: async () => { repo.stopSyncObserver() } }
}

// Let the deferred idle run() fire (setTimeout(0) under node — no
// requestIdleCallback) then drain the in-flight audit, mirroring the
// scheduleReconcileRescan test's `settle`.
const settle = async (repo: Repo): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0))
  await repo.awaitConsistencyAudits()
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db); env = setup(sharedDb.db) })
afterEach(async () => { await env.cleanup() })

describe('repo.scheduleConsistencyAudit — built-in L3 self-audit', () => {
  it('runs on a healthy workspace and records no anomalies', async () => {
    env.repo.scheduleConsistencyAudit('ws-1')
    await settle(env.repo)

    const audit = env.repo.metrics().consistencyAudit
    expect(audit.runs).toBe(1)
    expect(audit.lastResult?.workspaceId).toBe('ws-1')
    expect(audit.lastResult?.anomalies).toBe(0)
    expect(audit.lastResult?.checks.references_index_mirror.status).toBe('ok')
  })

  it('flags a mirror anomaly — an orphan block_references row (source block gone)', async () => {
    await sharedDb.db.execute(
      `INSERT INTO block_references (source_id, target_id, workspace_id, alias, source_field)
       VALUES ('missing-src', 'tgt', 'ws-2', 'tgt', '')`,
    )

    env.repo.scheduleConsistencyAudit('ws-2')
    await settle(env.repo)

    const result = env.repo.metrics().consistencyAudit.lastResult
    expect(result?.anomalies).toBeGreaterThanOrEqual(1)
    const mirror = result?.checks.references_index_mirror
    expect(mirror?.status).toBe('anomaly')
    expect(mirror?.orphanSourceRows).toBe(1)
  })

  it('is cadenced — a second schedule within the window skips re-running', async () => {
    env.repo.scheduleConsistencyAudit('ws-3')
    await settle(env.repo)
    expect(env.repo.metrics().consistencyAudit.runs).toBe(1)

    env.repo.scheduleConsistencyAudit('ws-3')
    await settle(env.repo)
    const audit = env.repo.metrics().consistencyAudit
    expect(audit.runs).toBe(1) // not re-run within the cadence window
    expect(audit.skipped).toBe(1) // cadence gate hit
  })
})

// The at-rest property-ref check has an irreducible benign baseline (empty/cleared
// next-review-date values project no ref). It must NOT flag an anomaly below the
// catastrophe floor, else the always-on health chip is permanently red.
describe('runConsistencyAudit — property_ref_at_rest catastrophe floor', () => {
  // Fake AuditDb: returns `propCount` for the property-ref count query (the only
  // one using `properties_json LIKE`), 0 for every other check's count.
  const fakeDb = (propCount: number): AuditDb => ({
    getAll: async <T = Record<string, unknown>>(sql: string): Promise<T[]> =>
      [{ n: sql.includes('properties_json LIKE') ? propCount : 0 }] as unknown as T[],
  })

  it('does not flag a small benign baseline (below the floor)', async () => {
    const result = await runConsistencyAudit(fakeDb(1), 'ws', 0)
    const check = result.checks.property_ref_at_rest
    expect(check.status).toBe('ok')
    expect(check.total).toBe(1) // reported, just not an anomaly
    expect(result.anomalies).toBe(0)
  })

  it('flags a catastrophic count (at/above the floor)', async () => {
    const result = await runConsistencyAudit(fakeDb(AT_REST_ANOMALY_FLOOR), 'ws', 0)
    expect(result.checks.property_ref_at_rest.status).toBe('anomaly')
    expect(result.anomalies).toBe(1)
  })

  it('captures sample block ids for a finding (and only queries them when the count is non-zero)', async () => {
    let sampleQueries = 0
    // count query → 2; sample query (SELECT id … LIMIT) → two ids; all else 0.
    const db: AuditDb = {
      getAll: async <T = Record<string, unknown>>(sql: string): Promise<T[]> => {
        if (sql.includes('properties_json LIKE')) {
          if (sql.includes('count(*)')) return [{ n: 2 }] as unknown as T[]
          sampleQueries += 1
          return [{ id: 'blk-a' }, { id: 'blk-b' }] as unknown as T[]
        }
        return [{ n: 0 }] as unknown as T[]
      },
    }
    const check = (await runConsistencyAudit(db, 'ws', 0)).checks.property_ref_at_rest
    expect(check.total).toBe(2)
    expect(check.samples).toEqual(['blk-a', 'blk-b'])
    expect(sampleQueries).toBe(1) // ran once, because the count was > 0
  })

  it('debounces transient divergence — a dirty pass that clears on recheck reports ok', async () => {
    let strandedCountCalls = 0
    let slept = 0
    // The stranded COUNT query is dirty (5) on the first measure, clean (0) on
    // the recheck; every other count is 0. Sample queries (SELECT b.id) only run
    // for the settled state, which is clean → none.
    const db: AuditDb = {
      getAll: async <T = Record<string, unknown>>(sql: string): Promise<T[]> => {
        // The stranded query is the only one with a `NOT EXISTS (… blocks_synced)`
        // subquery (the others JOIN blocks_synced); its count is dirty then clean.
        if (sql.includes('count(*)') && sql.includes('NOT EXISTS (SELECT 1 FROM blocks_synced')) {
          strandedCountCalls += 1
          return [{ n: strandedCountCalls === 1 ? 5 : 0 }] as unknown as T[]
        }
        return [{ n: 0 }] as unknown as T[]
      },
    }
    const result = await runConsistencyAudit(db, 'ws', 0, {
      divergenceRecheckMs: 1,
      sleep: async () => { slept += 1 },
    })
    const div = result.checks.local_server_divergence
    expect(div.status).toBe('ok') // transient cleared on recheck
    expect(div.rechecked).toBe(true)
    expect(div.strandedLocalOnly).toBe(0)
    expect(slept).toBe(1)
    expect(strandedCountCalls).toBe(2) // measured twice
    expect(result.anomalies).toBe(0)
  })

  it('does not run sample queries when a check is clean', async () => {
    let sampleQueries = 0
    const db: AuditDb = {
      getAll: async <T = Record<string, unknown>>(sql: string): Promise<T[]> => {
        // A sample query never selects count(*); flag any non-count SELECT as one.
        if (!sql.includes('count(*)')) sampleQueries += 1
        return [{ n: 0 }] as unknown as T[]
      },
    }
    const result = await runConsistencyAudit(db, 'ws', 0)
    expect(result.anomalies).toBe(0)
    expect(sampleQueries).toBe(0) // clean path runs zero sample queries
  })
})
