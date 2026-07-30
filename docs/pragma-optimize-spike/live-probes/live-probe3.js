// Alternating full / limited ANALYZE, repeated, each in a rolled-back write
// transaction. Two things the earlier run left ambiguous:
//   1. timing variance on a LIVE app (sync + rendering compete for the worker)
//   2. whether `PRAGMA analysis_limit` inside the tx actually took effect --
//      asserted directly from the stat values ANALYZE produced (an unbounded
//      run records 75200 rows/workspace on idx_block_references_ws_alias; a
//      limited run cannot record more than ~401).
const out = {runs: []}
const ROLLBACK = new Error('__rollback__')

const one = async limit => {
  const r = {limit}
  try {
    await db.writeTransaction(async tx => {
      await tx.execute('PRAGMA analysis_limit=' + limit)
      r.limitInEffect = ((await tx.execute('PRAGMA analysis_limit')).rows?._array ?? [])[0]?.analysis_limit
      const t = performance.now()
      await tx.execute('ANALYZE')
      r.ms = Math.round(performance.now() - t)
      const rows = (await tx.execute(
        "SELECT stat FROM sqlite_stat1 WHERE tbl='block_references' AND idx='idx_block_references_ws_alias'",
      )).rows?._array ?? []
      r.producedStat = rows[0]?.stat
      throw ROLLBACK
    })
  } catch (e) { if (e !== ROLLBACK) r.error = String(e?.message ?? e) }
  return r
}

for (let i = 0; i < 3; i++) {
  out.runs.push(await one(0))
  out.runs.push(await one(400))
}
out.unchanged = (await db.getAll(
  "SELECT stat FROM sqlite_stat1 WHERE tbl='block_references' AND idx='idx_block_references_ws_alias'",
))[0]?.stat
return out
