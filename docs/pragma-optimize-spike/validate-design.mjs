// End-to-end validation of the concrete replacement design against every case
// the current machinery exists to cover.
//
//   PRAGMA analysis_limit = 400
//   EXPLAIN QUERY PLAN <one representative query per hot table>   -- arm
//   PRAGMA optimize
//
// The arming step is load-bearing: experiment A showed the stale-stats half of
// optimize's heuristic only fires for tables this CONNECTION has planned a query
// against. Preparing is enough -- EXPLAIN QUERY PLAN never touches a data page.
// The new-index half needs no arming, but arming costs ~nothing.
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, rmSync, existsSync } from 'node:fs'

const FIXTURE = new URL('fixture.db', import.meta.url).pathname
const WORK = new URL('work7.db', import.meta.url).pathname
const freshCopy = () => {
  for (const s of ['', '-wal', '-shm']) if (existsSync(WORK + s)) rmSync(WORK + s)
  copyFileSync(FIXTURE, WORK)
  return new DatabaseSync(WORK)
}
const reopen = () => new DatabaseSync(WORK)
const probe = new DatabaseSync(FIXTURE, {readOnly: true})
const WS = probe.prepare(`SELECT workspace_id w FROM block_references GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1`).get().w
const CTX = JSON.stringify(probe.prepare(
  `SELECT source_id id FROM block_references WHERE workspace_id=? GROUP BY source_id HAVING COUNT(*)>=2 LIMIT 4`,
).all(WS).map(r => r.id))
probe.close()

// One planner-visible probe per hot table. EXPLAIN QUERY PLAN, so nothing is read.
const ARM = [
  ['SELECT id FROM blocks WHERE workspace_id = ? AND deleted = 0', [WS]],
  ['SELECT target_id FROM block_references WHERE workspace_id = ? AND alias = ?', [WS, 'alias-1']],
  ['SELECT block_id FROM block_types WHERE type = ? AND workspace_id = ?', ['type-1', WS]],
  ['SELECT block_id FROM block_aliases WHERE workspace_id = ? AND alias = ?', [WS, 'alias-1']],
]
const runDesign = db => {
  const t = performance.now()
  db.exec('PRAGMA analysis_limit=400')
  for (const [sql, params] of ARM) db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params)
  const armed = Math.round((performance.now() - t) * 10) / 10
  const t2 = performance.now()
  db.exec('PRAGMA optimize')
  return {armMs: armed, optimizeMs: Math.round((performance.now() - t2) * 10) / 10}
}

const CANDIDATES = `
  WITH context_ids(id) AS (SELECT value FROM json_each(?))
  SELECT bt.block_id, bt.type FROM context_ids c
    JOIN block_types bt ON bt.block_id = c.id AND bt.workspace_id = ?
  UNION
  SELECT refs.source_id, bt.type FROM context_ids c
    JOIN block_references refs ON refs.source_id = c.id AND refs.workspace_id = ?
    JOIN block_types bt ON bt.block_id = refs.target_id AND bt.workspace_id = ?
  ORDER BY 1, 2`
const P = [CTX, WS, WS, WS]
const timeQuery = db => {
  let best = Infinity, rows = 0
  for (let i = 0; i < 3; i++) {
    const t = performance.now()
    rows = db.prepare(CANDIDATES).all(...P).length
    best = Math.min(best, Math.round((performance.now() - t) * 10) / 10)
  }
  if (rows === 0) throw new Error('0 rows — timing would be meaningless')
  return best
}
// sqlite_stat1 does not exist until something has analyzed — the 'never
// analyzed' case reads stats before that is true.
const st = (db, tbl, idx) =>
  !db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_stat1'`).get()
    ? null
    : db.prepare(`SELECT stat FROM sqlite_stat1 WHERE tbl=? AND idx=?`).get(tbl, idx)?.stat ?? null

const cases = {
  // The regression this machinery was built for.
  'new index over analyzed DB': db => {
    db.exec('ANALYZE')
    db.exec('DROP INDEX idx_block_references_ws_alias')
    db.exec('CREATE INDEX idx_block_references_ws_alias ON block_references (workspace_id, alias)')
  },
  // block_references dropped+rebuilt (backfillBlockReferencesSourceFieldIfNeeded).
  'side table dropped and rebuilt': db => {
    db.exec('ANALYZE')
    db.exec('CREATE TABLE _bak AS SELECT * FROM block_references')
    db.exec('DROP TABLE block_references')
    db.exec(`CREATE TABLE block_references (source_id TEXT NOT NULL, target_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL, alias TEXT NOT NULL, source_field TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (source_id, target_id, alias, source_field))`)
    db.exec('CREATE INDEX idx_block_references_target ON block_references (target_id, workspace_id)')
    db.exec('CREATE INDEX idx_block_references_ws_alias ON block_references (workspace_id, alias)')
    db.exec('INSERT INTO block_references SELECT * FROM _bak')
    db.exec('DROP TABLE _bak')
  },
  // Legacy "0 0" stats.
  'degenerate 0 0 stats': db => {
    db.exec('ANALYZE')
    db.exec(`UPDATE sqlite_stat1 SET stat='0 0' WHERE tbl IN ('blocks','block_references','block_types')`)
  },
  // Never analyzed at all (fresh device).
  'never analyzed': () => {},
  // ANALYZE landed mid-sync over a nearly-empty table.
  'analyzed while tiny, then filled': db => {
    db.exec('CREATE TABLE _r AS SELECT * FROM block_references')
    db.exec('CREATE TABLE _t AS SELECT * FROM block_types')
    db.exec('DELETE FROM block_references WHERE rowid > 500')
    db.exec('DELETE FROM block_types WHERE rowid > 500')
    db.exec('ANALYZE')
    db.exec('INSERT INTO block_references SELECT * FROM _r WHERE true ON CONFLICT DO NOTHING')
    db.exec('INSERT INTO block_types SELECT * FROM _t WHERE true ON CONFLICT DO NOTHING')
    db.exec('DROP TABLE _r; DROP TABLE _t')
  },
  // The gap the CURRENT fingerprint documents as accepted.
  'block_types empty at ANALYZE, then fills': db => {
    db.exec('CREATE TABLE _t AS SELECT * FROM block_types')
    db.exec('DELETE FROM block_types')
    db.exec('ANALYZE')
    db.exec('INSERT INTO block_types SELECT * FROM _t')
    db.exec('DROP TABLE _t')
  },
  // Control: healthy, fully analyzed. Must be a no-op.
  'settled (control)': db => { db.exec('ANALYZE') },
}

const results = {}
for (const [label, setup] of Object.entries(cases)) {
  const db = freshCopy()
  setup(db)
  db.close()
  const b = reopen()                       // next boot
  const before = timeQuery(b)
  const beforeStats = {
    ws_alias: st(b, 'block_references', 'idx_block_references_ws_alias'),
    types_pk: st(b, 'block_types', 'sqlite_autoindex_block_types_1'),
    blocks_ws: st(b, 'blocks', 'idx_blocks_workspace_active'),
  }
  const cost = runDesign(b)
  const after = timeQuery(b)
  const afterStats = {
    ws_alias: st(b, 'block_references', 'idx_block_references_ws_alias'),
    types_pk: st(b, 'block_types', 'sqlite_autoindex_block_types_1'),
    blocks_ws: st(b, 'blocks', 'idx_blocks_workspace_active'),
  }
  b.close()
  results[label] = {queryMsBefore: before, queryMsAfter: after, ...cost, beforeStats, afterStats}
  console.log(`\n### ${label}\n` + JSON.stringify(results[label], null, 2))
}

console.log('\n\n===== SUMMARY (query ms before -> after, cost of the design) =====')
for (const [k, v] of Object.entries(results)) {
  console.log(
    k.padEnd(40),
    `${String(v.queryMsBefore).padStart(7)} -> ${String(v.queryMsAfter).padStart(5)} ms`,
    ` | arm ${String(v.armMs).padStart(5)}ms + optimize ${String(v.optimizeMs).padStart(6)}ms`,
  )
}
