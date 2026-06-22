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
  type AuditDecryptDeps,
  type DecryptSpotCheckResult,
} from '@/data/internals/consistencyAudit'
import {
  BLOCKS_SYNCED_RAW_TABLE,
  BLOCK_STORAGE_COLUMNS,
  blockToRowParams,
} from '@/data/blockSchema'
import { encodeForWire, type Materializability } from '@/sync/transform.js'
import { generateWorkspaceKeyBytes, importWorkspaceKey } from '@/sync/crypto/workspaceKey.js'
import type { BlockData } from '@/data/api'
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

// On an e2ee workspace `blocks_synced` holds `enc:v1:` ciphertext while `blocks`
// holds decrypted plaintext, so a naive cross-view content diff flags every row.
// These run against a real DB: the SQL must compare only cleartext columns on
// e2ee rows, the new at-rest check must catch un-materialized ciphertext, and the
// optional decrypt spot-check must recover content-divergence detection.
describe('runConsistencyAudit — e2ee encryption-awareness', () => {
  const WS = 'ws-e2ee'
  const STAMP = 1700000000000
  const COLUMN_NAMES = BLOCK_STORAGE_COLUMNS.map(c => c.name)
  const INSERT_BLOCK_SQL =
    `INSERT INTO blocks (${COLUMN_NAMES.join(', ')}) VALUES (${COLUMN_NAMES.map(() => '?').join(', ')})`

  const block = (overrides: Partial<BlockData> = {}): BlockData => ({
    id: 'b1',
    workspaceId: WS,
    parentId: null,
    orderKey: 'a0',
    content: 'hello',
    properties: {},
    references: [],
    createdAt: STAMP,
    updatedAt: STAMP,
    userUpdatedAt: STAMP,
    createdBy: 'user-1',
    updatedBy: 'user-1',
    deleted: false,
    ...overrides,
  })

  const seal = (key: CryptoKey, d: BlockData) =>
    encodeForWire(
      {
        id: d.id,
        workspace_id: d.workspaceId,
        content: d.content,
        properties_json: JSON.stringify(d.properties),
        references_json: JSON.stringify(d.references),
      },
      'e2ee',
      async () => key,
    )

  // Stage a `blocks_synced` row carrying ciphertext in the three content columns.
  const stageCiphertext = async (
    meta: BlockData,
    wire: { content: string; properties_json: string; references_json: string },
  ): Promise<void> => {
    const params = blockToRowParams(meta)
    params[4] = wire.content
    params[5] = wire.properties_json
    params[6] = wire.references_json
    await sharedDb.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, params)
  }

  const seedLocal = (d: BlockData) =>
    sharedDb.db.execute(INSERT_BLOCK_SQL, blockToRowParams(d))

  const decryptDeps = (
    key: CryptoKey,
    materializability: Materializability,
  ): AuditDecryptDeps => ({
    getMaterializability: async () => materializability,
    getCek: async () => key,
  })

  it('does NOT flag an equal-stamp e2ee row as a standoff (cleartext-only diff)', async () => {
    const key = await importWorkspaceKey(generateWorkspaceKeyBytes())
    const d = block({ id: 'enc1', content: 'secret note', properties: { alias: ['Secret'] } })
    await seedLocal(d) // local plaintext
    await stageCiphertext(d, await seal(key, d)) // server ciphertext, same stamp

    // Cleartext-only (no decrypt deps): the byte-diff would have flagged this row
    // pre-fix (plaintext != ciphertext); now it must read clean.
    const result = await runConsistencyAudit(sharedDb.db, WS, 0)
    const div = result.checks.local_server_divergence
    expect(div.status).toBe('ok')
    expect(div.equalStampStandoff).toBe(0)
    expect(div.decryptSpotCheck).toBeUndefined() // omitted without decrypt deps
    expect(result.anomalies).toBe(0)
  })

  it('flags a cleartext divergence (deleted differs) even on an e2ee row', async () => {
    const key = await importWorkspaceKey(generateWorkspaceKeyBytes())
    const d = block({ id: 'enc2', content: 'note' })
    await seedLocal({ ...d, deleted: false })
    // Same stamp, ciphertext content, but server says deleted — a real violation
    // the cleartext comparison still catches.
    await stageCiphertext({ ...d, deleted: true }, await seal(key, d))

    const result = await runConsistencyAudit(sharedDb.db, WS, 0)
    expect(result.checks.local_server_divergence.status).toBe('anomaly')
    expect(result.checks.local_server_divergence.equalStampStandoff).toBe(1)
  })

  it('flags a local row whose content is genuine ciphertext (materialized_still_ciphertext, decrypt-verified)', async () => {
    const key = await importWorkspaceKey(generateWorkspaceKeyBytes())
    const d = block({ id: 'enc3', content: 'secret note' })
    const wire = await seal(key, d)
    // Materialization failure: ciphertext landed in `blocks.content` (props/refs
    // stay valid JSON — the alias/types triggers reject ciphertext there).
    await seedLocal({ ...d, content: wire.content })

    const result = await runConsistencyAudit(sharedDb.db, WS, 0, {
      decrypt: decryptDeps(key, 'decrypt'),
    })
    const check = result.checks.materialized_still_ciphertext
    expect(check.status).toBe('anomaly')
    expect(check.encPrefixed).toBe(1)
    expect(check.confirmed).toBe(1) // content decrypts under the WK ⇒ genuine ciphertext
    expect(check.samples).toEqual(['enc3'])
  })

  it('does NOT flag a plaintext note that merely starts with enc:v1: (decrypt-verified)', async () => {
    const key = await importWorkspaceKey(generateWorkspaceKeyBytes())
    // A note literally about the envelope format — plaintext content with the prefix.
    const d = block({ id: 'enc7', content: 'enc:v1: is the envelope prefix' })
    await seedLocal(d) // local plaintext (prefix-shaped but real text)
    await stageCiphertext(d, await seal(key, d)) // server holds the true ciphertext

    const result = await runConsistencyAudit(sharedDb.db, WS, 0, {
      decrypt: decryptDeps(key, 'decrypt'),
    })
    const check = result.checks.materialized_still_ciphertext
    expect(check.encPrefixed).toBe(1) // it IS prefix-shaped
    expect(check.confirmed).toBe(0) // but decrypt-verify rejects it as not real ciphertext
    expect(check.status).toBe('ok')
    // and the spot-check sees local == decrypt(server), so divergence stays clean
    expect(result.checks.local_server_divergence.status).toBe('ok')
  })

  it('reports the raw prefix count as info (not anomaly) without a key resolver', async () => {
    const key = await importWorkspaceKey(generateWorkspaceKeyBytes())
    const d = block({ id: 'enc8', content: 'note' })
    const wire = await seal(key, d)
    await seedLocal({ ...d, content: wire.content }) // genuine ciphertext content, but no deps

    // No decrypt deps → can't confirm; the prefix count is surfaced as info.
    const result = await runConsistencyAudit(sharedDb.db, WS, 0)
    const check = result.checks.materialized_still_ciphertext
    expect(check.status).toBe('ok')
    expect(check.encPrefixed).toBe(1)
    expect(check.confirmed).toBeNull()
  })

  it('decrypt spot-check: matching plaintext decrypts equal → ok', async () => {
    const key = await importWorkspaceKey(generateWorkspaceKeyBytes())
    const d = block({ id: 'enc4', content: 'secret note', properties: { alias: ['Secret'] } })
    await seedLocal(d)
    await stageCiphertext(d, await seal(key, d))

    const result = await runConsistencyAudit(sharedDb.db, WS, 0, {
      decrypt: decryptDeps(key, 'decrypt'),
    })
    const div = result.checks.local_server_divergence
    const spot = div.decryptSpotCheck as DecryptSpotCheckResult
    expect(div.status).toBe('ok')
    expect(spot.status).toBe('ok')
    expect(spot.sampled).toBe(1)
    expect(spot.mismatches).toBe(0)
    expect(result.anomalies).toBe(0)
  })

  it('decrypt spot-check: server plaintext differs from local at equal stamp → anomaly', async () => {
    const key = await importWorkspaceKey(generateWorkspaceKeyBytes())
    // Server sealed "server version"; local plaintext diverged without bumping the
    // stamp — the e2ee analogue of equalStampStandoff, invisible to the SQL diff.
    const server = block({ id: 'enc5', content: 'server version' })
    const local = block({ id: 'enc5', content: 'local DIVERGED version' })
    await seedLocal(local)
    await stageCiphertext(server, await seal(key, server))

    const result = await runConsistencyAudit(sharedDb.db, WS, 0, {
      decrypt: decryptDeps(key, 'decrypt'),
    })
    const div = result.checks.local_server_divergence
    const spot = div.decryptSpotCheck as DecryptSpotCheckResult
    expect(div.status).toBe('anomaly')
    expect(spot.status).toBe('anomaly')
    expect(spot.mismatches).toBe(1)
    expect(spot.samples).toEqual(['enc5'])
    expect(result.anomalies).toBeGreaterThanOrEqual(1)
  })

  it('decrypt spot-check: skipped on a non-decryptable (locked/defer) workspace', async () => {
    const key = await importWorkspaceKey(generateWorkspaceKeyBytes())
    const d = block({ id: 'enc6', content: 'note' })
    await seedLocal(d)
    await stageCiphertext(d, await seal(key, d))

    const result = await runConsistencyAudit(sharedDb.db, WS, 0, {
      decrypt: decryptDeps(key, 'defer'),
    })
    const spot = result.checks.local_server_divergence.decryptSpotCheck as DecryptSpotCheckResult
    expect(spot.status).toBe('skipped')
    expect(spot.sampled).toBe(0)
  })
})
