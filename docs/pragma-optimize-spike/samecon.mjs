// Can the whole regression be reproduced and repaired WITHIN one connection,
// inside one transaction? That is the only shape testable on the live client
// (PowerSync owns its connection; I cannot force it to reopen).
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, rmSync, existsSync } from 'node:fs'
const FIXTURE = new URL('fixture.db', import.meta.url).pathname
const WORK = new URL('work6.db', import.meta.url).pathname
for (const s of ['', '-wal', '-shm']) if (existsSync(WORK + s)) rmSync(WORK + s)
copyFileSync(FIXTURE, WORK)
const db = new DatabaseSync(WORK)
db.exec('ANALYZE')
db.close()

const q = (d, sql) => d.prepare(sql).all()
const b = new DatabaseSync(WORK)

console.log('--- T1: direct sqlite_stat1 edit, same connection (what the live probe did)')
b.exec('BEGIN')
b.exec(`UPDATE sqlite_stat1 SET stat='0 0' WHERE tbl='blocks'`)
b.exec('PRAGMA analysis_limit=400')
console.log('  dry(0x03):', JSON.stringify(q(b, 'PRAGMA optimize(0x03)').map(r => r.optimize)))
b.exec('PRAGMA optimize')
console.log('  repaired? ', q(b, `SELECT stat FROM sqlite_stat1 WHERE tbl='blocks' AND idx='idx_blocks_workspace_active'`)[0].stat)
b.exec('ROLLBACK')

console.log('--- T2: same, but reload stats with ANALYZE sqlite_master first')
b.exec('BEGIN')
b.exec(`UPDATE sqlite_stat1 SET stat='0 0' WHERE tbl='blocks'`)
b.exec('ANALYZE sqlite_master')
b.exec('PRAGMA analysis_limit=400')
console.log('  dry(0x03):', JSON.stringify(q(b, 'PRAGMA optimize(0x03)').map(r => r.optimize)))
b.exec('PRAGMA optimize')
console.log('  repaired? ', q(b, `SELECT stat FROM sqlite_stat1 WHERE tbl='blocks' AND idx='idx_blocks_workspace_active'`)[0].stat)
b.exec('ROLLBACK')

console.log('--- T3: CREATE a new index in this same connection, then optimize')
b.exec('BEGIN')
b.exec('CREATE INDEX idx_spike_tmp ON block_references (alias, workspace_id)')
b.exec('PRAGMA analysis_limit=400')
console.log('  dry(0x03):', JSON.stringify(q(b, 'PRAGMA optimize(0x03)').map(r => r.optimize)))
const t = performance.now()
b.exec('PRAGMA optimize')
console.log('  optimizeMs:', Math.round(performance.now() - t))
console.log('  stat row for the new index:', JSON.stringify(q(b, `SELECT idx, stat FROM sqlite_stat1 WHERE idx='idx_spike_tmp'`)))
b.exec('ROLLBACK')
console.log('  after rollback, index gone?', q(b, `SELECT name FROM sqlite_master WHERE name='idx_spike_tmp'`).length === 0)
b.close()
