// Round 3: the growth-direction cases the current machinery exists to cover.
//   F — stats baked while the table was small / empty, then it fills
//   G — the block_types "empty at ANALYZE time" gap the current fingerprint
//       explicitly ACCEPTS (see SELECT_STAT1_KEYS_SQL's doc comment)
//   H — cost of a no-op optimize on a settled DB, and of the whole thing
//       relative to today's unconditional full ANALYZE
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, 'fixture.db')
const WORK = join(here, 'work3.db')

const freshCopy = () => {
  for (const s of ['', '-wal', '-shm']) if (existsSync(WORK + s)) rmSync(WORK + s)
  copyFileSync(FIXTURE, WORK)
  return new DatabaseSync(WORK)
}
const reopen = () => new DatabaseSync(WORK)
const ms = fn => { const t = performance.now(); fn(); return Math.round((performance.now() - t) * 10) / 10 }

const probe = new DatabaseSync(FIXTURE, {readOnly: true})
const WS = probe.prepare(`SELECT workspace_id w FROM block_references GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1`).get().w
const CTX = JSON.stringify(probe.prepare(
  `SELECT source_id id FROM block_references WHERE workspace_id=? GROUP BY source_id HAVING COUNT(*)>=2 LIMIT 4`,
).all(WS).map(r => r.id))
probe.close()

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
  return {ms: best, rows}
}
const stat = (db, tbl, idx) => db.prepare(
  `SELECT stat FROM sqlite_stat1 WHERE tbl=? AND idx=?`).get(tbl, idx)?.stat ?? null
const dryRun = db => db.prepare('PRAGMA optimize(-1)').all().map(r => r.optimize)

const out = {}
const say = (k, v) => { out[k] = v; console.log(`\n### ${k}\n` + JSON.stringify(v, null, 2)) }

// ---------------------------------------------------------------------------
// F — analyzed while small, then grown. Simulates ANALYZE landing mid-sync
//     (the case ANALYZE_MIN_BLOCKS and the materialization gate protect).
//     Done by analyzing a copy stripped down to N rows, then restoring the rows.
// ---------------------------------------------------------------------------
const grewFrom = (keptRows, label) => {
  const db = freshCopy()
  // Park the full tables aside, shrink to `keptRows`, ANALYZE, then restore.
  db.exec(`CREATE TABLE _refs_bak AS SELECT * FROM block_references`)
  db.exec(`CREATE TABLE _types_bak AS SELECT * FROM block_types`)
  db.exec(`CREATE TABLE _blocks_bak AS SELECT * FROM blocks`)
  db.exec(`DELETE FROM block_references WHERE rowid > ${keptRows}`)
  db.exec(`DELETE FROM block_types WHERE rowid > ${keptRows}`)
  db.exec(`DELETE FROM blocks WHERE rowid > ${keptRows}`)
  db.exec('ANALYZE')
  const staleStats = {
    ws_alias: stat(db, 'block_references', 'idx_block_references_ws_alias'),
    blocks_ws: stat(db, 'blocks', 'idx_blocks_workspace_active'),
  }
  db.exec(`INSERT INTO block_references SELECT * FROM _refs_bak WHERE true
           ON CONFLICT DO NOTHING`)
  db.exec(`INSERT INTO block_types SELECT * FROM _types_bak WHERE true ON CONFLICT DO NOTHING`)
  db.exec(`INSERT INTO blocks SELECT * FROM _blocks_bak WHERE true ON CONFLICT DO NOTHING`)
  db.exec('DROP TABLE _refs_bak; DROP TABLE _types_bak; DROP TABLE _blocks_bak')
  db.close()

  // Next boot: fresh connection, app runs the query (arming the used flag), then
  // the idle job would run optimize.
  const b = reopen()
  const beforeFix = timeQuery(b)
  b.exec('PRAGMA analysis_limit=400')
  const proposed = dryRun(b).filter(s => /block_references|block_types|"blocks"/.test(s))
  const optimizeMs = ms(() => b.exec('PRAGMA optimize'))
  const afterStats = {
    ws_alias: stat(b, 'block_references', 'idx_block_references_ws_alias'),
    blocks_ws: stat(b, 'blocks', 'idx_blocks_workspace_active'),
  }
  const afterFix = timeQuery(b)
  b.close()
  return {staleStats, beforeFix, proposed, optimizeMs, afterStats, afterFix}
}
say('F/analyzed-small-then-grown', {
  'analyzed at 1k rows': grewFrom(1000),
  'analyzed at 30k rows': grewFrom(30000),
})

// ---------------------------------------------------------------------------
// G — the gap the current fingerprint documents as ACCEPTED: block_types empty
//     when ANALYZE ran (so no stat1 row at all), later fills.
// ---------------------------------------------------------------------------
{
  const db = freshCopy()
  db.exec(`CREATE TABLE _types_bak AS SELECT * FROM block_types`)
  db.exec('DELETE FROM block_types')
  db.exec('ANALYZE')
  const emptyStat = {
    pk: stat(db, 'block_types', 'sqlite_autoindex_block_types_1'),
    typeWs: stat(db, 'block_types', 'idx_block_types_type_workspace'),
  }
  db.exec('INSERT INTO block_types SELECT * FROM _types_bak')
  db.exec('DROP TABLE _types_bak')
  db.close()

  const b = reopen()
  const beforeFix = timeQuery(b)
  b.exec('PRAGMA analysis_limit=400')
  const proposed = dryRun(b).filter(s => s.includes('block_types'))
  const optimizeMs = ms(() => b.exec('PRAGMA optimize'))
  const afterStat = {
    pk: stat(b, 'block_types', 'sqlite_autoindex_block_types_1'),
    typeWs: stat(b, 'block_types', 'idx_block_types_type_workspace'),
  }
  const afterFix = timeQuery(b)
  b.close()
  say('G/block_types-empty-at-analyze-then-fills', {
    emptyStat, beforeFix, proposed, optimizeMs, afterStat, afterFix,
  })
}

// ---------------------------------------------------------------------------
// H — steady-state cost. What does each boot pay?
// ---------------------------------------------------------------------------
{
  const db = freshCopy()
  db.exec('PRAGMA analysis_limit=400')
  db.exec('PRAGMA optimize')
  db.close()
  const settled = []
  for (let i = 0; i < 5; i++) {
    const b = reopen()
    b.prepare(CANDIDATES).all(...P)               // arm the used flag, as the app does
    b.exec('PRAGMA analysis_limit=400')
    settled.push(ms(() => b.exec('PRAGMA optimize')))
    b.close()
  }
  const c = reopen()
  const fullAnalyzeMs = ms(() => c.exec('ANALYZE'))   // what today's path costs when it fires
  c.close()
  say('H/steady-state-per-boot-cost', {
    optimizeMsPerBoot: settled,
    fullAnalyzeMsForComparison: fullAnalyzeMs,
  })
}
