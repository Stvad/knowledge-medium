// The proposed sequence, run end-to-end on the live client.
//
// Every write is inside a transaction that is rolled back, INCLUDING the
// `PRAGMA optimize` itself. An earlier revision ran the optimize directly on the
// connection on the theory that a settled database makes it a no-op — true for
// the client this was written against, but it made the script unsafe to re-run
// anywhere else: on a database that is NOT settled it would rewrite
// `sqlite_stat1` for real, and checking afterwards cannot undo that.
//
// `PRAGMA analysis_limit` is CONNECTION-scoped, not transaction-scoped, so the
// rollback does NOT restore it — it has to be reset explicitly, on every path.
const out = {}
const rows = r => r?.rows?._array ?? []
const HOT = "('blocks','block_references','block_types','block_aliases')"
const snap = async () => Object.fromEntries((await db.getAll(
  "SELECT tbl||'/'||COALESCE(idx,'') k, stat FROM sqlite_stat1 WHERE tbl IN " + HOT + " ORDER BY 1",
)).map(r => [r.k, r.stat]))

out.before = await snap()
const ws = repo.activeWorkspaceId

// Arming probes: EXPLAIN QUERY PLAN only, so no data page is ever read.
const ARM = [
  ['SELECT id FROM blocks WHERE workspace_id = ? AND deleted = 0', [ws]],
  ['SELECT target_id FROM block_references WHERE workspace_id = ? AND alias = ?', [ws, 'x']],
  ['SELECT block_id FROM block_types WHERE type = ? AND workspace_id = ?', ['x', ws]],
  ['SELECT block_id FROM block_aliases WHERE workspace_id = ? AND alias = ?', [ws, 'x']],
]

const ROLLBACK = new Error('__rollback__')
try {
  try {
    await db.writeTransaction(async tx => {
      const t0 = performance.now()
      await tx.execute('PRAGMA analysis_limit=400')
      for (const [sql, params] of ARM) await tx.execute('EXPLAIN QUERY PLAN ' + sql, params)
      out.armMs = Math.round(performance.now() - t0)

      out.dryRun_defaultMask = rows(await tx.execute('PRAGMA optimize(0x03)')).map(r => r.optimize)
      const t1 = performance.now()
      await tx.execute('PRAGMA optimize')
      out.optimizeMs = Math.round(performance.now() - t1)
      throw ROLLBACK
    })
  } catch (e) { if (e !== ROLLBACK) out.error = String(e?.message ?? e) }
} finally {
  await db.execute('PRAGMA analysis_limit=0')
}

out.analysisLimitRestored = (await db.getAll('PRAGMA analysis_limit'))[0]?.analysis_limit
out.after = await snap()
out.nothingWritten = JSON.stringify(out.before) === JSON.stringify(out.after)
return out
