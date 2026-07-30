// The exact proposed sequence, run on the live client. On a settled DB this is
// a no-op, so nothing is written -- verified by comparing sqlite_stat1 before
// and after outside any transaction.
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

const t0 = performance.now()
await db.execute('PRAGMA analysis_limit=400')
for (const [sql, params] of ARM) await db.execute('EXPLAIN QUERY PLAN ' + sql, params)
out.armMs = Math.round(performance.now() - t0)

out.dryRun_defaultMask = rows(await db.execute('PRAGMA optimize(0x03)')).map(r => r.optimize)
const t1 = performance.now()
await db.execute('PRAGMA optimize')
out.optimizeMs = Math.round(performance.now() - t1)

await db.execute('PRAGMA analysis_limit=0')
out.after = await snap()
out.nothingWritten = JSON.stringify(out.before) === JSON.stringify(out.after)
return out
