// Build a fixture DB that reproduces the live client's cardinalities, using the
// live client's exact DDL (dumped from sqlite_master).
//
// Targets, all read off the live client's sqlite_stat1 + COUNT(DISTINCT ...):
//   blocks              347_350 rows, 325_848 with deleted=0, 3 workspaces,
//                       parent fanout ~4, 114_243 with references_json != '[]',
//                       23_525 with reference_target_id NOT NULL (one workspace)
//   block_references    225_600 rows, 3 ws, 33_140 aliases, 28_068 targets,
//                       114_247 sources
//   block_types          64_343 rows, 52 types, 55_128 typed blocks, 3 ws
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, 'fixture.db')

const N_BLOCKS = 347_350
const N_ACTIVE = 325_848
const N_WS = 3
const N_REFS = 225_600
const N_ALIASES = 33_140
const N_TARGETS = 28_068
const N_SOURCES = 114_247
const N_TYPE_ROWS = 64_343
const N_TYPES = 52
const N_TYPED_BLOCKS = 55_128
const N_WITH_REFS = 114_243
const N_REF_TARGET = 23_525
const N_DAILY = 4_164

// Deterministic PRNG so runs are comparable.
let seed = 0x2f6e2b1
const rnd = () => {
  seed ^= seed << 13; seed >>>= 0
  seed ^= seed >>> 17
  seed ^= seed << 5; seed >>>= 0
  return seed / 0x100000000
}

// Block ids are UUID-shaped strings in production; length matters for page
// counts (and therefore for how much ANALYZE has to read), so keep 36 chars.
const blockId = i => `${String(i).padStart(8, '0')}-0000-4000-8000-${String(i).padStart(12, '0')}`
const wsId = w => `${String(w).padStart(8, 'f')}-1111-4111-8111-111111111111`

const schema = JSON.parse(readFileSync(join(here, 'live-schema.json'), 'utf8')).rows

// fts5 shadow tables are created by the virtual table itself.
const FTS_SHADOWS = /^blocks_fts_(data|idx|content|docsize|config)$/
// PowerSync internals + unrelated tables: keep them (ANALYZE walks every table,
// so their presence is part of the cost picture) but they stay empty, exactly as
// most of them are on the live client.
const skip = name => FTS_SHADOWS.test(name) || name === 'sqlite_stat1' || name === 'sqlite_sequence'

if (existsSync(OUT)) rmSync(OUT)
const db = new DatabaseSync(OUT)
db.exec('PRAGMA journal_mode=WAL')

const tables = schema.filter(r => r.type === 'table' && !skip(r.name))
const indexes = schema.filter(r => r.type === 'index')
const triggers = schema.filter(r => r.type === 'trigger')

for (const t of tables) db.exec(t.sql)
// Indexes AFTER the bulk load would be faster, but the point of the fixture is
// to end up in the live client's exact schema state; build order is irrelevant
// to the experiments, and creating them first keeps this script simple.
for (const i of indexes) db.exec(i.sql)
// Triggers are deliberately NOT created: the side tables (block_references,
// block_types, block_aliases, blocks_fts) are seeded directly, so live triggers
// would double-write them. The experiments never write through `blocks`.
console.log(`schema: ${tables.length} tables, ${indexes.length} indexes (${triggers.length} triggers skipped)`)

const t0 = performance.now()
db.exec('BEGIN')

const insBlock = db.prepare(`INSERT INTO blocks
  (id, workspace_id, parent_id, order_key, content, properties_json, references_json,
   created_at, updated_at, user_updated_at, created_by, updated_by, deleted,
   reference_target_id, is_field_form)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)

const user = '00000000-dead-4000-8000-000000000001'
for (let i = 0; i < N_BLOCKS; i++) {
  // Workspace skew: the live client is 3 workspaces with one dominant. ANALYZE
  // records only the average (75_200 rows/ws on block_references), so the exact
  // skew does not change the recorded stat, but keeping it realistic keeps the
  // planner's real work realistic too.
  const w = i % 100 < 92 ? 0 : (i % 100 < 97 ? 1 : 2)
  const deleted = i >= N_ACTIVE ? 1 : 0
  const parent = i < 4 ? null : blockId(Math.floor(i / 4))
  const hasRefs = i % 1000 < Math.round((N_WITH_REFS / N_BLOCKS) * 1000)
  const refsJson = hasRefs
    ? JSON.stringify([{id: blockId(Math.floor(rnd() * N_TARGETS)), alias: `alias-${Math.floor(rnd() * N_ALIASES)}`}])
    : '[]'
  const refTarget = i < N_REF_TARGET ? blockId(Math.floor(rnd() * N_TARGETS)) : null
  const props = i < N_DAILY
    ? `{"daily-note-date":"2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}"}`
    : '{}'
  insBlock.run(
    blockId(i), wsId(w), parent, `a${i.toString(36)}`,
    `block content number ${i} with some words in it`,
    props, refsJson,
    1700000000000 + i, 1700000000000 + i, null, user, user, deleted,
    refTarget, null,
  )
}
console.log(`blocks seeded: ${Math.round(performance.now() - t0)}ms`)

// block_references: 225_600 rows over 114_247 sources, 28_068 targets,
// 33_140 aliases, 3 workspaces.
const insRef = db.prepare(
  `INSERT OR IGNORE INTO block_references (source_id, target_id, workspace_id, alias, source_field) VALUES (?,?,?,?,?)`,
)
let refRows = 0
for (let i = 0; refRows < N_REFS; i++) {
  const src = Math.floor(rnd() * N_SOURCES)
  const tgt = Math.floor(rnd() * N_TARGETS)
  const alias = Math.floor(rnd() * N_ALIASES)
  const w = src % 100 < 92 ? 0 : (src % 100 < 97 ? 1 : 2)
  const r = insRef.run(blockId(src), blockId(tgt), wsId(w), `alias-${alias}`, '')
  refRows += r.changes
  if (i > N_REFS * 4) break
}
console.log(`block_references seeded: ${refRows}`)

// block_types: 64_343 rows over 55_128 blocks, 52 types.
const insType = db.prepare(
  `INSERT OR IGNORE INTO block_types (block_id, workspace_id, type) VALUES (?,?,?)`,
)
let typeRows = 0
for (let i = 0; typeRows < N_TYPE_ROWS; i++) {
  const b = Math.floor(rnd() * N_TYPED_BLOCKS)
  const w = b % 100 < 92 ? 0 : (b % 100 < 97 ? 1 : 2)
  // Type popularity is heavily skewed on the live client (52 types, 1238
  // rows/type average) — a Zipf-ish pick keeps a few hot types.
  const t = Math.floor(Math.pow(rnd(), 2) * N_TYPES)
  const r = insType.run(blockId(b), wsId(w), `type-${t}`)
  typeRows += r.changes
  if (i > N_TYPE_ROWS * 4) break
}
console.log(`block_types seeded: ${typeRows}`)

// block_aliases (30_709 rows) — not in the query under test, but ANALYZE walks
// it, so it belongs in the timing picture.
const insAlias = db.prepare(
  `INSERT OR IGNORE INTO block_aliases (block_id, workspace_id, alias, alias_lower) VALUES (?,?,?,?)`,
)
let aliasRows = 0
for (let i = 0; aliasRows < 30_709; i++) {
  const b = Math.floor(rnd() * N_BLOCKS)
  const w = b % 100 < 92 ? 0 : (b % 100 < 97 ? 1 : 2)
  aliasRows += insAlias.run(blockId(b), wsId(w), `Alias-${i}`, `alias-${i}`).changes
  if (i > 60_000) break
}
console.log(`block_aliases seeded: ${aliasRows}`)

// row_events: 444_222 rows on the live client, and the single biggest table
// ANALYZE has to walk. Matters for Q4 only.
const insEvent = db.prepare(
  `INSERT INTO row_events (tx_id, block_id, kind, before_json, after_json, source, created_at)
   VALUES (?,?,?,?,?,?,?)`,
)
for (let i = 0; i < 444_222; i++) {
  insEvent.run(
    `tx-${Math.floor(i / 9)}`, blockId(Math.floor(rnd() * N_BLOCKS)), 'update',
    null, '{}', 'local', 1700000000000 + i,
  )
}
console.log(`row_events seeded: 444222`)

db.exec('COMMIT')

// FTS: 318_606 documents on the live client. Populated last, outside the main
// transaction, because trigram tokenization is the slow part of the seed.
const t1 = performance.now()
db.exec('BEGIN')
const insFtsRowid = db.prepare(`INSERT INTO blocks_fts_rowids (fts_rowid, block_id) VALUES (?,?)`)
const insFts = db.prepare(`INSERT INTO blocks_fts (rowid, content, workspace_id, block_id) VALUES (?,?,?,?)`)
for (let i = 0; i < 318_606; i++) {
  const w = i % 100 < 92 ? 0 : (i % 100 < 97 ? 1 : 2)
  insFtsRowid.run(i + 1, blockId(i))
  insFts.run(i + 1, `block content number ${i} with some words in it`, wsId(w), blockId(i))
}
db.exec('COMMIT')
console.log(`fts seeded: ${Math.round(performance.now() - t1)}ms`)

db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
db.close()
console.log(`total: ${Math.round(performance.now() - t0)}ms`)
