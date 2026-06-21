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
