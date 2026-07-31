// Q1, definitively: does PRAGMA optimize WRITE sqlite_stat1 under wa-sqlite /
// OPFS, on PowerSync's own write connection, triggered by a newly created index,
// with no prior query on that connection?
//
// Creates a throwaway index inside a write transaction that is then rolled back.
// Verified offline (samecon.mjs T3) that this reproduces the production trigger
// within a single connection -- unlike a direct sqlite_stat1 edit, which SQLite's
// in-memory stats copy hides from the heuristic.
const out = {}
const ROLLBACK = new Error('__rollback__')
const rows = r => r?.rows?._array ?? []

try {
  await db.writeTransaction(async tx => {
    const t0 = performance.now()
    await tx.execute('CREATE INDEX idx_spike_tmp ON block_references (alias, workspace_id)')
    out.createIndexMs = Math.round(performance.now() - t0)

    await tx.execute('PRAGMA analysis_limit=400')
    out.dryRun_defaultMask = rows(await tx.execute('PRAGMA optimize(0x03)')).map(r => r.optimize)
    out.dryRun_allBits = rows(await tx.execute('PRAGMA optimize(-1)')).map(r => r.optimize)

    const t1 = performance.now()
    await tx.execute('PRAGMA optimize')
    out.optimizeMs = Math.round(performance.now() - t1)

    out.statForNewIndex = rows(await tx.execute(
      "SELECT idx, stat FROM sqlite_stat1 WHERE idx = 'idx_spike_tmp'",
    ))
    out.statForExistingIndexes = rows(await tx.execute(
      "SELECT idx, stat FROM sqlite_stat1 WHERE tbl = 'block_references' ORDER BY idx",
    ))
    throw ROLLBACK
  })
} catch (e) { if (e !== ROLLBACK) out.error = String(e?.message ?? e) }

// Reset the connection-scoped limit FIRST, before any validation read. On a
// client that had never been analyzed, the rollback also removed the
// `sqlite_stat1` the optimize created — so the read below throws "no such
// table" and, if the reset came after it, the live connection would be left
// sampling at 400.
await db.execute('PRAGMA analysis_limit=0')
out.analysisLimitRestored = (await db.getAll('PRAGMA analysis_limit'))[0]?.analysis_limit

// Prove the rollback was clean: the throwaway index must be gone and the real
// stats untouched.
out.indexGoneAfterRollback = (await db.getAll(
  "SELECT name FROM sqlite_master WHERE name = 'idx_spike_tmp'",
)).length === 0
out.liveStatsUntouched = (await db.getAll(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_stat1'",
)).length === 0
  ? '(no sqlite_stat1 — this client had never been analyzed)'
  : await db.getAll(
    "SELECT idx, stat FROM sqlite_stat1 WHERE tbl = 'block_references' ORDER BY idx",
  )
return out
