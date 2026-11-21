const out = {}
const ROLLBACK = new Error('__rollback__')
// Every measurement runs inside a write transaction that is rolled back, so the
// client's sqlite_stat1 is never modified.
const timed = async (label, limit, stmts) => {
  try {
    await db.writeTransaction(async tx => {
      await tx.execute('PRAGMA analysis_limit=' + limit)
      const t = performance.now()
      for (const s of stmts) await tx.execute(s)
      out[label] = Math.round(performance.now() - t)
      throw ROLLBACK
    })
  } catch (e) { if (e !== ROLLBACK) out[label] = 'ERR: ' + (e && e.message ? e.message : e) }
}

// Baseline: what an empty write transaction costs on OPFS. Bounds how much of
// the numbers below is VFS overhead rather than real ANALYZE work.
await timed('emptyTxMs', 0, ['SELECT 1'])

// Whole-database ANALYZE, repeated, to see variance.
await timed('fullAnalyze_1', 0, ['ANALYZE'])
await timed('fullAnalyze_2', 0, ['ANALYZE'])
await timed('limitedAnalyze400_1', 400, ['ANALYZE'])
await timed('limitedAnalyze400_2', 400, ['ANALYZE'])
await timed('limitedAnalyze100', 100, ['ANALYZE'])

// Per-table at limit=400. `PRAGMA optimize` in the regression scenario runs
// exactly ONE of these, not the whole-database pass.
const tables = ['block_references', 'block_types', 'blocks', 'block_aliases', 'row_events', 'blocks_fts', 'ps_oplog']
for (const t of tables) await timed('limited400_' + t, 400, ['ANALYZE ' + t])

// Unbounded, for the two that matter most.
await timed('full_block_references', 0, ['ANALYZE block_references'])
await timed('full_blocks', 0, ['ANALYZE blocks'])

// Connection-scoped, so none of the rollbacks above restored it. The last
// `timed()` call happens to set 0, but relying on statement order for that is
// how the production connection gets left sampling.
await db.execute('PRAGMA analysis_limit=0')
out.analysisLimitRestored = (await db.getAll('PRAGMA analysis_limit'))[0]?.analysis_limit

out.stat1Unchanged = (await db.getAll(
  "SELECT stat FROM sqlite_stat1 WHERE tbl='block_references' AND idx='idx_block_references_ws_alias'"
))[0]?.stat
return out
