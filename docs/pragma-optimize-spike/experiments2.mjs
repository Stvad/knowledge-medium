// Round 2: the boundary conditions a replacement would depend on.
//   A — what counts as "used on this connection" for the stale-stats rule
//   B — do analysis_limit=400 stats change the plan of OTHER hot queries
//   E — does optimize subsume the row-count-drift axis (ANALYZE_GROWTH_FACTOR)
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, 'fixture.db')
const WORK = join(here, 'work2.db')

const freshCopy = () => {
  for (const s of ['', '-wal', '-shm']) if (existsSync(WORK + s)) rmSync(WORK + s)
  copyFileSync(FIXTURE, WORK)
  return new DatabaseSync(WORK)
}
const reopen = () => new DatabaseSync(WORK)
const dryRun = db => db.prepare('PRAGMA optimize(-1)').all().map(r => r.optimize)
const blocksStat = db => db.prepare(
  `SELECT stat FROM sqlite_stat1 WHERE tbl='blocks' AND idx='idx_blocks_workspace_active'`,
).get()?.stat ?? null

const probe = new DatabaseSync(FIXTURE, {readOnly: true})
const WS = probe.prepare(`SELECT workspace_id w FROM block_references GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1`).get().w
probe.close()

const out = {}
const say = (k, v) => { out[k] = v; console.log(`\n### ${k}\n` + JSON.stringify(v, null, 2)) }

// ---------------------------------------------------------------------------
// A — the stale-stats rule needs the table "used on this connection". What
//     exactly counts? Set blocks' stats to the degenerate "0 0" shape, then on a
//     fresh connection do exactly one thing before PRAGMA optimize.
// ---------------------------------------------------------------------------
const zeroZero = () => {
  const db = freshCopy()
  db.exec('ANALYZE')
  db.exec(`UPDATE sqlite_stat1 SET stat='0 0' WHERE tbl='blocks'`)
  db.close()
}

const triggers = {
  'nothing': () => {},
  'SELECT COUNT(*) FROM blocks': db => db.prepare('SELECT COUNT(*) c FROM blocks').get(),
  'indexed SELECT on blocks': db => db.prepare('SELECT id FROM blocks WHERE workspace_id=? AND deleted=0 LIMIT 5').all(WS),
  'EXPLAIN QUERY PLAN only': db => db.prepare('EXPLAIN QUERY PLAN SELECT id FROM blocks WHERE workspace_id=? AND deleted=0').all(WS),
  'prepare without step': db => db.prepare('SELECT id FROM blocks WHERE workspace_id=? AND deleted=0'),
  'UPDATE one row': db => db.prepare(`UPDATE blocks SET content=content WHERE id=(SELECT id FROM blocks LIMIT 1)`).run(),
  'query a DIFFERENT table': db => db.prepare('SELECT COUNT(*) c FROM block_types').get(),
}
const aResults = {}
for (const [label, fn] of Object.entries(triggers)) {
  zeroZero()
  const db = reopen()
  fn(db)
  db.exec('PRAGMA analysis_limit=400')
  const proposedByDryRun = dryRun(db).some(s => s.includes('"blocks"'))
  db.exec('PRAGMA optimize')
  aResults[label] = {proposedByDryRun, statAfter: blocksStat(db), fixed: blocksStat(db) !== '0 0'}
  db.close()
}
say('A/what-counts-as-used', aResults)

// ---------------------------------------------------------------------------
// B — do analysis_limit=400 stats plan the app's other hot queries the same way
//     full stats do? Any divergence is a cost of the cheaper scan.
// ---------------------------------------------------------------------------
const B_QUERIES = {
  'subtree CTE (treeQueries)': [`
    WITH RECURSIVE d(id, depth) AS (
      SELECT id, 0 FROM blocks WHERE id = ?
      UNION ALL
      SELECT child.id, d.depth + 1
        FROM d JOIN blocks AS child INDEXED BY idx_blocks_parent_order
          ON child.parent_id = d.id AND child.deleted = 0
       WHERE d.depth < 20
    ) SELECT COUNT(*) FROM d`, ['00000010-0000-4000-8000-000000000010']],
  'backlinks by target': [`
    SELECT b.id, b.content FROM block_references r
      JOIN blocks b ON b.id = r.source_id AND b.deleted = 0
     WHERE r.target_id = ? AND r.workspace_id = ?`, ['00000010-0000-4000-8000-000000000010', WS]],
  'alias enumeration (renameProcessor)': [`
    SELECT source_id, target_id FROM block_references WHERE workspace_id = ? AND alias = ?`, [WS, 'alias-77']],
  'typed blocks by type': [`
    SELECT b.id FROM block_types t JOIN blocks b ON b.id = t.block_id AND b.deleted = 0
     WHERE t.type = ? AND t.workspace_id = ?`, ['type-3', WS]],
  'children by parent': [`
    SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id`,
    ['00000010-0000-4000-8000-000000000010']],
  'workspace active scan': [`
    SELECT COUNT(*) FROM blocks WHERE workspace_id = ? AND deleted = 0`, [WS]],
  'refs of a source': [`
    SELECT target_id, alias FROM block_references WHERE source_id = ?`,
    ['00000010-0000-4000-8000-000000000010']],
  'grouped-backlinks candidates': [`
    WITH context_ids(id) AS (SELECT value FROM json_each(?))
    SELECT bt.block_id, bt.type FROM context_ids c
      JOIN block_types bt ON bt.block_id = c.id AND bt.workspace_id = ?
    UNION
    SELECT refs.source_id, bt.type FROM context_ids c
      JOIN block_references refs ON refs.source_id = c.id AND refs.workspace_id = ?
      JOIN block_types bt ON bt.block_id = refs.target_id AND bt.workspace_id = ?
    ORDER BY 1, 2`,
    [JSON.stringify(['00000000-0000-4000-8000-000000000000', '00000001-0000-4000-8000-000000000001']), WS, WS, WS]],
}

const plansFor = mode => {
  const db = freshCopy()
  if (mode === 'limited') db.exec('PRAGMA analysis_limit=400')
  db.exec('ANALYZE')
  const p = {}
  for (const [name, [sql, params]] of Object.entries(B_QUERIES)) {
    p[name] = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map(r => r.detail).join(' | ')
  }
  db.close()
  return p
}
const full = plansFor('full')
const limited = plansFor('limited')
const diffs = {}
for (const k of Object.keys(B_QUERIES)) {
  if (full[k] !== limited[k]) diffs[k] = {full: full[k], limited: limited[k]}
}
say('B/plan-divergence-full-vs-limited', {
  queries: Object.keys(B_QUERIES).length,
  divergent: Object.keys(diffs).length,
  diffs,
})

// ---------------------------------------------------------------------------
// E — does optimize cover the row-count-drift axis (ANALYZE_GROWTH_FACTOR)?
//     Settle, then move the row count a long way, then reopen + query + optimize.
// ---------------------------------------------------------------------------
const drift = (label, mutate) => {
  const db = freshCopy()
  db.exec('ANALYZE')
  const before = blocksStat(db)
  mutate(db)
  const realCount = db.prepare('SELECT COUNT(*) c FROM blocks').get().c
  db.close()
  const b = reopen()
  // Production's idle job queries blocks (COUNT) before deciding, so mirror that.
  b.prepare('SELECT id FROM blocks WHERE workspace_id=? AND deleted=0 LIMIT 5').all(WS)
  b.exec('PRAGMA analysis_limit=400')
  const proposed = dryRun(b).some(s => s.includes('"blocks"'))
  b.exec('PRAGMA optimize')
  const after = blocksStat(b)
  b.close()
  return {before, realCount, proposedByDryRun: proposed, after, reanalyzed: before !== after}
}

say('E/row-count-drift', {
  'delete 90% (347k -> 35k)': drift('shrink', db => {
    db.exec(`DELETE FROM blocks WHERE rowid % 10 != 0`)
  }),
  'delete 99% (347k -> 3.5k)': drift('shrink-hard', db => {
    db.exec(`DELETE FROM blocks WHERE rowid % 100 != 0`)
  }),
  'no change (control)': drift('none', () => {}),
})

console.log('\n\n===== SUMMARY =====')
console.log(JSON.stringify(out, null, 2).slice(0, 200) + ' ...')
