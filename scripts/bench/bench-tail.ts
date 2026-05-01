/**
 * row_events tail benchmarks.
 *
 * The tail is the sync-applied invalidation path (spec §9.3 path 2):
 * sync writes hit SQLite via PowerSync's CRUD-apply, the trigger writes
 * row_events with `source = 'sync'`, and this subscription drains them
 * into cache updates + handle invalidations.
 *
 * What we measure:
 *   - Tail flush throughput: insert N synthetic sync rows directly into
 *     row_events (with source='sync') + an updated `blocks` row, call
 *     tail.flush(), measure wall time.
 *   - Tail flush with M registered handles whose deps match a fraction
 *     of the rows.
 *
 * The synthetic insert path: we INSERT into blocks via `db.execute`
 * outside any tx_context (so source IS NULL), and the row_events
 * trigger COALESCEs to 'sync'. That's exactly what the production sync
 * apply path produces, so the tail consumes it the same way.
 *
 * Deferred (would need PowerSync internals): measuring tail latency
 * end-to-end through a real sync apply (we'd need a syncing connection,
 * which makes this an integration test, not a microbench).
 */

import { v4 as uuidv4 } from 'uuid'
import { LoaderHandle, handleKey } from '@/data/internals/handleStore'
import { bench, time, type BenchResult } from './harness'
import { setupBenchEnv } from './setup'
import { populateFlat } from './fixtures'

/** Insert N rows mimicking a sync-applied burst. tx_context is NOT set,
 *  so the row_events trigger tags them `source='sync'`. */
const insertSyncRows = async (
  db: import('@/data/internals/commitPipeline').PowerSyncDb,
  args: {workspaceId: string; count: number; parentId?: string | null},
): Promise<string[]> => {
  const ids: string[] = []
  await db.writeTransaction(async (tx) => {
    // Defensive: clear tx_context so the trigger's COALESCE picks 'sync'.
    // (createTestDb leaves it NULL by default, but a prior tx in the
    // same suite could have raced — be explicit.)
    await tx.execute(
      `UPDATE tx_context SET tx_id = NULL, tx_seq = NULL, user_id = NULL, scope = NULL, source = NULL WHERE id = 1`,
    )
    for (let i = 0; i < args.count; i++) {
      const id = uuidv4()
      ids.push(id)
      await tx.execute(
        `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
                             properties_json, references_json,
                             created_at, updated_at, created_by, updated_by, deleted)
         VALUES (?, ?, ?, ?, ?, '{}', '[]', ?, ?, 'sync', 'sync', 0)`,
        [id, args.workspaceId, args.parentId ?? null, `s${i.toString().padStart(5, '0')}`, `sync-${i}`,
         Date.now(), Date.now()],
      )
    }
  })
  return ids
}

export const runTailBenches = async (): Promise<BenchResult[]> => {
  const out: BenchResult[] = []

  // ──── Tail flush throughput at varying burst size ────
  // Re-enable the row_events tail explicitly; the default bench setup
  // disables it.
  for (const N of [10, 100, 1000, 10000]) {
    const env = await setupBenchEnv({skipRowEventsTail: false})
    // Pre-populate the workspace so existing rows don't pollute the
    // tail's per-iteration count.
    const w = await populateFlat(env.db, 100)

    let total = 0
    let totalSql = 0
    const r = await bench(`row_events tail flush (burst N=${N})`, async () => {
      // Insert a fresh sync burst. Each iteration creates N new rows.
      const t0 = await time(() => insertSyncRows(env.db, {workspaceId: w.workspaceId, count: N}))
      total += t0.ms
      // Flush the tail.
      const t1 = await time(async () => { await env.repo.flushRowEventsTail() })
      totalSql += t1.ms
    }, {warmup: 1, iters: 3})
    r.metadata = {
      N,
      msPerRow: (r.meanMs / N).toFixed(3),
      avgInsertMs: (total / r.iterations).toFixed(1),
      avgFlushMs: (totalSql / r.iterations).toFixed(1),
    }
    out.push(r)
    await env.cleanup()
  }

  // ──── Tail flush with M registered handles (1k matching, 9k bystander) ────
  {
    const env = await setupBenchEnv({skipRowEventsTail: false})
    const w = await populateFlat(env.db, 100)
    // Register 10k synthetic handles, half depending on workspace, half
    // on unrelated rows.
    const M = 10000
    for (let i = 0; i < M; i++) {
      const synthId = `synth-${i}`
      const matchesSync = i < 1000
      const key = handleKey('synth-tail', {id: synthId})
      const h = env.repo.handleStore.getOrCreate<LoaderHandle<string>>(
        key,
        () => new LoaderHandle<string>({
          store: env.repo.handleStore, key,
          loader: async (ctx) => {
            if (matchesSync) {
              ctx.depend({kind: 'workspace', workspaceId: w.workspaceId})
            } else {
              ctx.depend({kind: 'row', id: synthId})
            }
            return synthId
          },
        }),
      )
      await h.load()
    }
    const r = await bench(`tail flush (burst N=100, ${M} handles, 1k match)`, async () => {
      await insertSyncRows(env.db, {workspaceId: w.workspaceId, count: 100})
      await env.repo.flushRowEventsTail()
    }, {warmup: 1, iters: 3})
    r.metadata = {N: 100, handles: M, matching: 1000}
    out.push(r)
    await env.cleanup()
  }

  return out
}
