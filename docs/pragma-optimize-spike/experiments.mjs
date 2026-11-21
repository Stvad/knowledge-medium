// Experiments against the fixture. Every experiment starts from a fresh copy of
// fixture.db so states never leak between them.
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, 'fixture.db')
const WORK = join(here, 'work.db')

const blockId = i => `${String(i).padStart(8, '0')}-0000-4000-8000-${String(i).padStart(12, '0')}`

// The real query, verbatim from SELECT_GROUPED_BACKLINK_TYPE_CANDIDATES_SQL.
const CANDIDATES_SQL = `
  WITH context_ids(id) AS (SELECT value FROM json_each(?))
  SELECT bt.block_id AS context_id, bt.type AS type_name
    FROM context_ids c
    JOIN block_types bt
      ON bt.block_id = c.id
     AND bt.workspace_id = ?
  UNION
  SELECT refs.source_id AS context_id, bt.type AS type_name
    FROM context_ids c
    JOIN block_references refs
      ON refs.source_id = c.id
     AND refs.workspace_id = ?
    JOIN block_types bt
      ON bt.block_id = refs.target_id
     AND bt.workspace_id = ?
  ORDER BY context_id, type_name
`

// 4 context ids, matching the measured real-world call (`4 ids` in the code
// comments). Read out of the fixture so they are guaranteed to be real sources
// in the dominant workspace — a context set that matches nothing would make
// every plan look free and hide the regression this spike is about.
const {WS, CONTEXT_IDS} = (() => {
  const probe = new DatabaseSync(FIXTURE, {readOnly: true})
  const ws = probe.prepare(
    `SELECT workspace_id w, COUNT(*) n FROM block_references GROUP BY 1 ORDER BY n DESC LIMIT 1`,
  ).get()
  const ids = probe.prepare(
    `SELECT source_id id FROM block_references WHERE workspace_id=? GROUP BY source_id
     HAVING COUNT(*) >= 2 LIMIT 4`,
  ).all(ws.w).map(r => r.id)
  probe.close()
  console.log(`context: workspace ${ws.w} (${ws.n} edges), ids ${JSON.stringify(ids)}`)
  return {WS: ws.w, CONTEXT_IDS: JSON.stringify(ids)}
})()
const PARAMS = [CONTEXT_IDS, WS, WS, WS]

const freshCopy = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(WORK + suffix)) rmSync(WORK + suffix)
  }
  copyFileSync(FIXTURE, WORK)
  return new DatabaseSync(WORK)
}

const ms = fn => {
  const t = performance.now()
  const out = fn()
  return [Math.round((performance.now() - t) * 10) / 10, out]
}

const plan = db => db.prepare('EXPLAIN QUERY PLAN ' + CANDIDATES_SQL).all(...PARAMS).map(r => r.detail)

/** Time the query the way it actually runs: prepare + execute, cold plan each
 *  time (production re-prepares per call through PowerSync). Best of 3. */
const timeQuery = db => {
  let best = Infinity
  let rows = 0
  for (let i = 0; i < 3; i++) {
    const [t, r] = ms(() => db.prepare(CANDIDATES_SQL).all(...PARAMS))
    rows = r.length
    best = Math.min(best, t)
  }
  // A context set that matches nothing makes every plan look free — the exact
  // way this measurement can pass for the wrong reason. Fail loudly instead.
  if (rows === 0) throw new Error('query returned 0 rows — the timing would be meaningless')
  return {ms: best, rows}
}

const stat1 = (db, tbls) => {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_stat1'`).get()) return null
  const q = tbls.map(() => '?').join(',')
  return Object.fromEntries(
    db.prepare(`SELECT tbl||'/'||COALESCE(idx,'') k, stat FROM sqlite_stat1 WHERE tbl IN (${q}) ORDER BY 1`)
      .all(...tbls).map(r => [r.k, r.stat]),
  )
}

const dryRun = db => db.prepare('PRAGMA optimize(-1)').all().map(r => r.optimize)

const HOT = ['block_types', 'block_references', 'blocks']
const results = {}
const record = (name, o) => { results[name] = o; console.log(`\n### ${name}\n` + JSON.stringify(o, null, 2)) }

// ---------------------------------------------------------------------------
// E1 — the four stat states, plan + latency of the real query in each.
// ---------------------------------------------------------------------------
{
  const db = freshCopy()
  record('E1a/no-stats', {plan: plan(db), query: timeQuery(db), stat1: stat1(db, HOT)})
  db.close()
}
{
  const db = freshCopy()
  const [t] = ms(() => db.exec('ANALYZE'))
  record('E1b/full-ANALYZE', {analyzeMs: t, plan: plan(db), query: timeQuery(db), stat1: stat1(db, HOT)})
  db.close()
}
{
  const db = freshCopy()
  db.exec('PRAGMA analysis_limit=400')
  const [t] = ms(() => db.exec('ANALYZE'))
  record('E1c/analysis_limit-400-ANALYZE', {analyzeMs: t, plan: plan(db), query: timeQuery(db), stat1: stat1(db, HOT)})
  db.close()
}
{
  // The headline proposal: fresh connection, NO prior query, from a DB that has
  // never been analyzed.
  const db = freshCopy()
  db.exec('PRAGMA analysis_limit=400')
  const proposed = dryRun(db)
  const [t] = ms(() => db.exec('PRAGMA optimize'))
  record('E1d/optimize-from-nothing-fresh-conn', {
    proposed, optimizeMs: t, plan: plan(db), query: timeQuery(db), stat1: stat1(db, HOT),
  })
  db.close()
}

// ---------------------------------------------------------------------------
// E2 — Q2, the actual regression: a NEW index over an already-analyzed DB.
// Mirrors `backfillBlockReferencesSourceFieldIfNeeded` (drops the table and
// recreates the index) and the original `idx_block_references_ws_alias` add.
// ---------------------------------------------------------------------------
const prepareNewIndexState = () => {
  const db = freshCopy()
  db.exec('ANALYZE')
  db.exec('DROP INDEX idx_block_references_ws_alias')
  db.exec('CREATE INDEX idx_block_references_ws_alias ON block_references (workspace_id, alias)')
  db.close()
  // Reopen: production hits this on the NEXT boot, on a connection that never
  // saw the old stats.
  return new DatabaseSync(WORK)
}
{
  const db = prepareNewIndexState()
  record('E2a/new-index-unfixed', {plan: plan(db), query: timeQuery(db), stat1: stat1(db, HOT)})
  db.close()
}
{
  const db = prepareNewIndexState()
  db.exec('PRAGMA analysis_limit=400')
  const proposed = dryRun(db)
  const [t] = ms(() => db.exec('PRAGMA optimize'))
  record('E2b/new-index-optimize-fresh-conn', {
    proposed, optimizeMs: t, plan: plan(db), query: timeQuery(db), stat1: stat1(db, HOT),
  })
  db.close()
}
{
  // Same, but the connection has run the query first — the "queried on this
  // connection" half of the heuristic.
  const db = prepareNewIndexState()
  db.prepare(CANDIDATES_SQL).all(...PARAMS)
  db.exec('PRAGMA analysis_limit=400')
  const proposed = dryRun(db)
  const [t] = ms(() => db.exec('PRAGMA optimize'))
  record('E2c/new-index-optimize-after-query', {
    proposed, optimizeMs: t, plan: plan(db), query: timeQuery(db), stat1: stat1(db, HOT),
  })
  db.close()
}
{
  // Control: what full ANALYZE does for the same state (this is today's fix).
  const db = prepareNewIndexState()
  const [t] = ms(() => db.exec('ANALYZE'))
  record('E2d/new-index-full-ANALYZE', {analyzeMs: t, plan: plan(db), query: timeQuery(db), stat1: stat1(db, HOT)})
  db.close()
}

// ---------------------------------------------------------------------------
// E3 — Q3, the legacy "0 0" stats state.
// ---------------------------------------------------------------------------
const prepareZeroZero = () => {
  const db = freshCopy()
  db.exec('ANALYZE')
  // Rewrite every `blocks` stat row to the degenerate all-zero shape.
  db.exec(`UPDATE sqlite_stat1 SET stat = '0 0' WHERE tbl='blocks'`)
  db.close()
  return new DatabaseSync(WORK)
}
{
  const db = prepareZeroZero()
  db.exec('PRAGMA analysis_limit=400')
  const before = stat1(db, ['blocks'])
  const proposed = dryRun(db)
  db.exec('PRAGMA optimize')
  record('E3a/zero-zero-optimize-fresh-conn', {before, proposed, after: stat1(db, ['blocks'])})
  db.close()
}
{
  const db = prepareZeroZero()
  // Same, but the connection has queried `blocks` first.
  db.prepare('SELECT id FROM blocks WHERE workspace_id=? AND deleted=0 LIMIT 5').all(WS)
  db.exec('PRAGMA analysis_limit=400')
  const proposed = dryRun(db)
  db.exec('PRAGMA optimize')
  record('E3b/zero-zero-optimize-after-query', {proposed, after: stat1(db, ['blocks'])})
  db.close()
}

// ---------------------------------------------------------------------------
// E4 — per-boot cost once settled, and whether it ever stops proposing.
// ---------------------------------------------------------------------------
{
  const db = freshCopy()
  db.exec('PRAGMA analysis_limit=400')
  db.exec('PRAGMA optimize')
  db.close()
  const boots = []
  for (let i = 0; i < 3; i++) {
    const b = new DatabaseSync(WORK)
    b.exec('PRAGMA analysis_limit=400')
    const proposed = dryRun(b)
    const [t] = ms(() => b.exec('PRAGMA optimize'))
    boots.push({proposed, optimizeMs: t})
    b.close()
  }
  record('E4/repeat-boots-after-settle', boots)
}
{
  // Same, but settled by a full ANALYZE (what production does today).
  const db = freshCopy()
  db.exec('ANALYZE')
  db.close()
  const boots = []
  for (let i = 0; i < 2; i++) {
    const b = new DatabaseSync(WORK)
    b.exec('PRAGMA analysis_limit=400')
    const proposed = dryRun(b)
    const [t] = ms(() => b.exec('PRAGMA optimize'))
    boots.push({proposed, optimizeMs: t})
    b.close()
  }
  record('E4b/repeat-boots-after-full-ANALYZE', boots)
}

console.log('\n\n===== SUMMARY =====')
for (const [k, v] of Object.entries(results)) {
  const q = v.query ?? v[0]?.query
  console.log(k.padEnd(38), JSON.stringify({
    analyzeMs: v.analyzeMs, optimizeMs: v.optimizeMs, queryMs: v.query?.ms, rows: v.query?.rows,
  }))
}
