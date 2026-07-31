// Round 4: is there a dry run that reflects what the DEFAULT mask will actually
// do? `optimize(-1)` sets every bit, including 0x10000 ("analyze all tables"),
// so it reports work the default mask declines. If `optimize(0x03)` (debug +
// 0x02) tracks the default, it becomes a read-only probe usable on the LIVE
// client — which is the only place the wa-sqlite/OPFS answer lives.
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, 'fixture.db')
const WORK = join(here, 'work4.db')
const freshCopy = () => {
  for (const s of ['', '-wal', '-shm']) if (existsSync(WORK + s)) rmSync(WORK + s)
  copyFileSync(FIXTURE, WORK)
  return new DatabaseSync(WORK)
}
const reopen = () => new DatabaseSync(WORK)
const probe = new DatabaseSync(FIXTURE, {readOnly: true})
const WS = probe.prepare(`SELECT workspace_id w FROM block_references GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1`).get().w
probe.close()

const masks = db => ({
  'optimize(-1)': db.prepare('PRAGMA optimize(-1)').all().map(r => r.optimize),
  'optimize(0x03)': db.prepare('PRAGMA optimize(0x03)').all().map(r => r.optimize),
  'optimize(0x02|0x01)': db.prepare('PRAGMA optimize(3)').all().map(r => r.optimize),
})
const blocksStat = db => db.prepare(
  `SELECT stat FROM sqlite_stat1 WHERE tbl='blocks' AND idx='idx_blocks_workspace_active'`).get()?.stat ?? null

const say = (k, v) => console.log(`\n### ${k}\n` + JSON.stringify(v, null, 2))

// Scenario 1: stale "0 0" stats, connection has NOT planned against blocks.
// Ground truth (experiment A): default optimize does NOT fix it.
{
  const db = freshCopy()
  db.exec('ANALYZE')
  db.exec(`UPDATE sqlite_stat1 SET stat='0 0' WHERE tbl='blocks'`)
  db.close()
  const b = reopen()
  b.exec('PRAGMA analysis_limit=400')
  const m = masks(b)
  b.exec('PRAGMA optimize')
  say('S1/stale-stats, blocks NOT planned against', {
    ...Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.filter(s => s.includes('"blocks"'))])),
    actuallyFixed: blocksStat(b) !== '0 0',
    statAfter: blocksStat(b),
  })
  b.close()
}

// Scenario 2: same, but the connection HAS planned against blocks.
// Ground truth: default optimize DOES fix it.
{
  const db = freshCopy()
  db.exec('ANALYZE')
  db.exec(`UPDATE sqlite_stat1 SET stat='0 0' WHERE tbl='blocks'`)
  db.close()
  const b = reopen()
  b.prepare('SELECT id FROM blocks WHERE workspace_id=? AND deleted=0 LIMIT 5').all(WS)
  b.exec('PRAGMA analysis_limit=400')
  const m = masks(b)
  b.exec('PRAGMA optimize')
  say('S2/stale-stats, blocks planned against', {
    ...Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.filter(s => s.includes('"blocks"'))])),
    actuallyFixed: blocksStat(b) !== '0 0',
    statAfter: blocksStat(b),
  })
  b.close()
}

// Scenario 3: fully settled. Nothing should be proposed under any mask for the
// hot tables.
{
  const db = freshCopy()
  db.exec('ANALYZE')
  db.close()
  const b = reopen()
  b.prepare('SELECT id FROM blocks WHERE workspace_id=? AND deleted=0 LIMIT 5').all(WS)
  b.exec('PRAGMA analysis_limit=400')
  say('S3/settled', masks(b))
  b.close()
}

// Scenario 4: new index, connection has planned nothing.
{
  const db = freshCopy()
  db.exec('ANALYZE')
  db.exec('DROP INDEX idx_block_references_ws_alias')
  db.exec('CREATE INDEX idx_block_references_ws_alias ON block_references (workspace_id, alias)')
  db.close()
  const b = reopen()
  b.exec('PRAGMA analysis_limit=400')
  const m = masks(b)
  b.exec('PRAGMA optimize')
  // Derived from the stat row, not from `!!db` — that was truthy no matter what
  // (a closed DatabaseSync is still an object), so it reported success even if
  // the behaviour under test had regressed.
  const wsAliasStat = b.prepare(
    `SELECT stat FROM sqlite_stat1 WHERE tbl='block_references' AND idx='idx_block_references_ws_alias'`,
  ).get()?.stat ?? null
  say('S4/new-index, nothing planned', {
    ...Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.filter(s => s.includes('block_references'))])),
    actuallyFixed: wsAliasStat !== null,
    wsAliasStat,
  })
  b.close()
}
