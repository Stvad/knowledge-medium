// @vitest-environment node
/**
 * Trigger-firing integration tests for the v2 client schema.
 *
 * Uses `node:sqlite` (built into Node ≥22) — same SQLite C library as
 * wa-sqlite, so trigger semantics are identical to what runs in the
 * browser via PowerSync. Sync API keeps the tests legible. No extra
 * dependency added.
 *
 * What this covers (data-layer-redesign §4.3 / §4.5 / §4.1.1):
 *   - row_events triggers fire for INSERT / UPDATE / DELETE
 *   - source COALESCE: NULL → 'sync'; 'user' / 'local-ephemeral' pass through
 *   - tx_id belt-and-suspenders: NULL when source is NULL, even with a
 *     stale tx_id left in tx_context
 *   - soft-delete UPDATE emits kind='soft-delete'
 *   - upload-routing triggers fire only on source = 'user'
 *   - workspace-invariant triggers reject cross-workspace + dangling
 *     parents on local writes; bypass cleanly on sync writes
 *   - all documented trigger names exist after running CLIENT_SCHEMA_STATEMENTS
 *
 * What this does NOT cover (deferred to later stages):
 *   - PowerSync's actual outgoing-queue behavior — we only check that the
 *     trigger writes a row to ps_crud, not that it ever reaches the server
 *   - Cycle prevention — engine-side, not trigger-side
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  BLOCKS_RAW_TABLE,
  BLOCK_STORAGE_COLUMNS,
  CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL,
  CREATE_BLOCKS_TABLE_SQL,
  CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL,
} from '@/data/blockSchema'
import {
  ALIAS_BACKFILL_MARKER_KEY,
  BACKFILL_BLOCK_ALIASES_SQL,
  CLIENT_SCHEMA_STATEMENTS,
  CLIENT_SCHEMA_TRIGGER_NAMES,
  backfillBlockAliasesIfEmpty,
} from './clientSchema'
import {
  BACKFILL_BLOCK_REFERENCES_SQL,
  BLOCK_REFERENCES_BACKFILL_MARKER_KEY,
  backlinksLocalSchema,
  backfillBlockReferencesIfEmpty,
} from '@/plugins/backlinks/localSchema.ts'

interface TestDb {
  db: DatabaseSync
  setTxContext: (ctx: { txId?: string | null; txSeq?: number | null; userId?: string | null; scope?: string | null; source?: string | null }) => void
  clearTxContext: () => void
  insertBlock: (overrides?: Partial<BlockInsert>) => void
  updateBlock: (id: string, set: Record<string, unknown>) => void
  deleteBlock: (id: string) => void
  rowEvents: () => Array<RowEventRow>
  psCrud: () => Array<{ id: number; data: string; tx_id: number | null }>
  rowEventCount: () => number
}

interface RowEventRow {
  id: number
  tx_id: string | null
  block_id: string
  kind: string
  before_json: string | null
  after_json: string | null
  source: string
  created_at: number
}

interface BlockInsert {
  id: string
  workspace_id: string
  parent_id: string | null
  order_key: string
  content: string
  properties_json: string
  references_json: string
  created_at: number
  updated_at: number
  created_by: string
  updated_by: string
  deleted: 0 | 1
}

const defaultBlock: BlockInsert = {
  id: 'b1',
  workspace_id: 'ws1',
  parent_id: null,
  order_key: 'a0',
  content: '',
  properties_json: '{}',
  references_json: '[]',
  created_at: 1700000000000,
  updated_at: 1700000000000,
  created_by: 'user-1',
  updated_by: 'user-1',
  deleted: 0,
}

const blockValues = (row: BlockInsert): Array<string | number | null> =>
  BLOCK_STORAGE_COLUMNS.map(c => row[c.name])

const setupDb = (): TestDb => {
  const db = new DatabaseSync(':memory:')

  // PowerSync's outgoing queue table. Real schema is
  // `(id INTEGER PK AUTOINCREMENT, data TEXT, tx_id INTEGER)`; the
  // upload-routing triggers populate (tx_id, data). PowerSync's
  // `getNextCrudTransaction()` groups CRUD entries by tx_id, so a
  // multi-row repo.tx must stamp every row with the same non-null
  // tx_id or atomicity intent is lost on the server.
  db.exec(`
    CREATE TABLE ps_crud (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT NOT NULL,
      tx_id INTEGER
    )
  `)

  // The blocks table (built from the same column list as production).
  db.exec(CREATE_BLOCKS_TABLE_SQL)
  db.exec(CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL)
  db.exec(CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL)

  for (const stmt of CLIENT_SCHEMA_STATEMENTS) {
    db.exec(stmt)
  }
  for (const stmt of backlinksLocalSchema.statements ?? []) {
    db.exec(stmt)
  }

  const columnNames = BLOCK_STORAGE_COLUMNS.map(c => c.name)
  const insertStmt = db.prepare(
    `INSERT INTO blocks (${columnNames.join(',')}) VALUES (${columnNames.map(() => '?').join(',')})`,
  )

  return {
    db,
    setTxContext: ({txId = null, txSeq = null, userId = null, scope = null, source = null}) => {
      db.exec(
        `UPDATE tx_context SET tx_id = ${sqlLit(txId)}, tx_seq = ${txSeq === null ? 'NULL' : String(txSeq)}, user_id = ${sqlLit(userId)}, scope = ${sqlLit(scope)}, source = ${sqlLit(source)} WHERE id = 1`,
      )
    },
    clearTxContext: () => {
      db.exec('UPDATE tx_context SET tx_id = NULL, tx_seq = NULL, user_id = NULL, scope = NULL, source = NULL WHERE id = 1')
    },
    insertBlock: (overrides = {}) => {
      const row = {...defaultBlock, ...overrides}
      insertStmt.run(...blockValues(row))
    },
    updateBlock: (id, set) => {
      const cols = Object.keys(set)
      const sql = `UPDATE blocks SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`
      db.prepare(sql).run(...cols.map(c => set[c] as string | number | null), id)
    },
    deleteBlock: (id) => {
      db.prepare('DELETE FROM blocks WHERE id = ?').run(id)
    },
    rowEvents: () => db.prepare('SELECT * FROM row_events ORDER BY id').all() as unknown as RowEventRow[],
    psCrud: () => db.prepare('SELECT * FROM ps_crud ORDER BY id').all() as unknown as { id: number; data: string; tx_id: number | null }[],
    rowEventCount: () => (db.prepare('SELECT COUNT(*) AS n FROM row_events').get() as {n: number}).n,
  }
}

const sqlLit = (v: string | null) => (v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`)

let h: TestDb
beforeEach(() => { h = setupDb() })
afterEach(() => { h.db.close() })

describe('client schema bootstrap', () => {
  it('creates the documented set of triggers on `blocks`', () => {
    const triggers = (h.db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='blocks' ORDER BY name")
      .all() as Array<{name: string}>)
      .map(r => r.name)
    const expected = [
      ...CLIENT_SCHEMA_TRIGGER_NAMES,
      ...(backlinksLocalSchema.triggerNames ?? []),
    ]
    expect(triggers.sort()).toEqual(expected.sort())
    expect(triggers).toHaveLength(expected.length)
  })

  it('seeds tx_context with one row that starts NULL across all five tx fields', () => {
    const ctx = h.db.prepare('SELECT * FROM tx_context').get() as Record<string, unknown>
    expect(ctx).toEqual({id: 1, tx_id: null, tx_seq: null, user_id: null, scope: null, source: null})
  })

  it('CLIENT_SCHEMA_STATEMENTS is idempotent', () => {
    for (const stmt of CLIENT_SCHEMA_STATEMENTS) {
      expect(() => h.db.exec(stmt)).not.toThrow()
    }
  })
})

describe('row_events trigger — INSERT', () => {
  it("tags source='user' and writes tx_id when local user tx is open", () => {
    h.setTxContext({txId: 'tx-A', userId: 'user-1', scope: 'block-default', source: 'user'})
    h.insertBlock({id: 'b1'})
    h.clearTxContext()
    const events = h.rowEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({block_id: 'b1', kind: 'create', source: 'user', tx_id: 'tx-A'})
    expect(events[0].before_json).toBeNull()
    expect(events[0].after_json).toContain('"id":"b1"')
  })

  it("tags source='local-ephemeral' for UI-state writes", () => {
    h.setTxContext({txId: 'tx-B', userId: 'user-1', scope: 'local-ui', source: 'local-ephemeral'})
    h.insertBlock({id: 'b2'})
    h.clearTxContext()
    expect(h.rowEvents()[0]).toMatchObject({source: 'local-ephemeral', tx_id: 'tx-B'})
  })

  it("COALESCEs NULL source to 'sync' and ZEROES tx_id (sync apply)", () => {
    // tx_context stays at its post-clear state: source IS NULL
    h.insertBlock({id: 'b3'})
    expect(h.rowEvents()[0]).toMatchObject({source: 'sync', tx_id: null})
  })

  it("belt-and-suspenders: stale tx_id with NULL source still emits tx_id=NULL", () => {
    // Simulate the failure mode: the engine forgot to clear tx_id but did clear source.
    h.db.exec("UPDATE tx_context SET tx_id = 'stale', source = NULL WHERE id = 1")
    h.insertBlock({id: 'b4'})
    expect(h.rowEvents()[0]).toMatchObject({source: 'sync', tx_id: null})
  })
})

describe('row_events trigger — UPDATE', () => {
  beforeEach(() => {
    // Seed an existing row via sync so its insert event is tagged 'sync'.
    h.insertBlock({id: 'b1'})
  })

  it("emits kind='update' for non-deleted-flip changes", () => {
    h.setTxContext({txId: 'tx-1', userId: 'user-1', scope: 'block-default', source: 'user'})
    h.updateBlock('b1', {content: 'edited', updated_at: 1700000999000})
    h.clearTxContext()
    const last = h.rowEvents().at(-1)!
    expect(last).toMatchObject({block_id: 'b1', kind: 'update', source: 'user', tx_id: 'tx-1'})
    expect(last.before_json).toContain('"content":""')
    expect(last.after_json).toContain('"content":"edited"')
  })

  it("emits kind='soft-delete' for deleted 0→1 transitions", () => {
    h.setTxContext({txId: 'tx-2', userId: 'user-1', scope: 'block-default', source: 'user'})
    h.updateBlock('b1', {deleted: 1})
    h.clearTxContext()
    const last = h.rowEvents().at(-1)!
    expect(last.kind).toBe('soft-delete')
    expect(last.before_json).toContain('"deleted":false')
    expect(last.after_json).toContain('"deleted":true')
  })

  it("emits kind='update' (not 'soft-delete') for already-deleted rows touched again", () => {
    // Land the soft-delete first.
    h.setTxContext({txId: 'tx-2', userId: 'user-1', scope: 'block-default', source: 'user'})
    h.updateBlock('b1', {deleted: 1})
    // Now touch the deleted row again — content edit on tombstone, kind stays 'update'.
    h.updateBlock('b1', {content: 'posthumous'})
    h.clearTxContext()
    const last = h.rowEvents().at(-1)!
    expect(last.kind).toBe('update')
  })
})

describe('PowerSync raw-table put', () => {
  it('does not fire UPDATE triggers for identical sync replays', () => {
    const put = h.db.prepare(BLOCKS_RAW_TABLE.put.sql)
    const row = {...defaultBlock, id: 'raw-put'}

    put.run(...blockValues(row))
    expect(h.rowEvents()).toHaveLength(1)
    expect(h.rowEvents()[0]).toMatchObject({block_id: 'raw-put', kind: 'create', source: 'sync'})

    put.run(...blockValues(row))
    expect(h.rowEvents()).toHaveLength(1)

    put.run(...blockValues({
      ...row,
      content: 'changed',
      updated_at: row.updated_at + 1,
    }))
    const events = h.rowEvents()
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({block_id: 'raw-put', kind: 'update', source: 'sync'})
    expect(events[1].before_json).toContain('"content":""')
    expect(events[1].after_json).toContain('"content":"changed"')
  })
})

describe('row_events trigger — DELETE', () => {
  it("emits kind='delete' on hard delete with before snapshot only", () => {
    h.insertBlock({id: 'b1'})
    h.deleteBlock('b1')
    const events = h.rowEvents()
    const del = events.at(-1)!
    expect(del.kind).toBe('delete')
    expect(del.before_json).toContain('"id":"b1"')
    expect(del.after_json).toBeNull()
  })
})

describe('upload-routing triggers', () => {
  it("forwards INSERT to ps_crud when source='user' and stamps tx_id from tx_seq", () => {
    h.setTxContext({txId: 'tx-1', txSeq: 4242, userId: 'user-1', scope: 'block-default', source: 'user'})
    h.insertBlock({id: 'b1'})
    h.clearTxContext()
    const crud = h.psCrud()
    expect(crud).toHaveLength(1)
    expect(crud[0].tx_id).toBe(4242)
    expect(JSON.parse(crud[0].data)).toMatchObject({op: 'PUT', type: 'blocks', id: 'b1'})
  })

  it("forwards UPDATE to ps_crud when source='user' and stamps tx_id from tx_seq", () => {
    h.insertBlock({id: 'b1'})  // sync insert
    h.setTxContext({txId: 'tx-1', txSeq: 5151, userId: 'user-1', scope: 'block-default', source: 'user'})
    h.updateBlock('b1', {content: 'x'})
    h.clearTxContext()
    const crud = h.psCrud()
    expect(crud).toHaveLength(1)
    expect(crud[0].tx_id).toBe(5151)
    expect(JSON.parse(crud[0].data)).toMatchObject({op: 'PATCH', id: 'b1'})
  })

  it('groups all writes from one tx under the same ps_crud.tx_id', () => {
    // Multi-row repo.tx — emulates two creates inside one writeTransaction
    // by holding tx_context constant across two inserts. PowerSync's
    // getNextCrudTransaction() depends on this tx_id grouping; without
    // it, atomicity intent is lost on the upload side.
    h.setTxContext({txId: 'tx-multi', txSeq: 7777, userId: 'user-1', scope: 'block-default', source: 'user'})
    h.insertBlock({id: 'mb-1'})
    h.insertBlock({id: 'mb-2'})
    h.clearTxContext()

    const crud = h.psCrud()
    expect(crud).toHaveLength(2)
    // Both rows share the tx_id stamped from tx_seq.
    expect(new Set(crud.map(r => r.tx_id))).toEqual(new Set([7777]))
    // Distinct envelopes per row.
    const ids = crud.map(r => JSON.parse(r.data).id).sort()
    expect(ids).toEqual(['mb-1', 'mb-2'])
  })

  it('two distinct repo.tx invocations get distinct ps_crud.tx_id', () => {
    h.setTxContext({txId: 'tx-a', txSeq: 100, userId: 'user-1', scope: 'block-default', source: 'user'})
    h.insertBlock({id: 'tx-a-block'})
    h.clearTxContext()
    h.setTxContext({txId: 'tx-b', txSeq: 101, userId: 'user-1', scope: 'block-default', source: 'user'})
    h.insertBlock({id: 'tx-b-block'})
    h.clearTxContext()

    const crud = h.psCrud()
    expect(crud).toHaveLength(2)
    // Each tx has its own grouping key.
    expect(new Set(crud.map(r => r.tx_id))).toEqual(new Set([100, 101]))
  })

  it("does NOT forward when source='local-ephemeral' (UI-state)", () => {
    h.setTxContext({txId: 'tx-2', userId: 'user-1', scope: 'local-ui', source: 'local-ephemeral'})
    h.insertBlock({id: 'b2'})
    h.clearTxContext()
    expect(h.psCrud()).toHaveLength(0)
  })

  it("does NOT forward sync-applied writes (source NULL → 'sync' is not 'user')", () => {
    h.insertBlock({id: 'b1'})  // source is NULL
    expect(h.psCrud()).toHaveLength(0)
  })

  it('v1 has no DELETE upload-routing trigger', () => {
    h.insertBlock({id: 'b1'})
    h.setTxContext({txId: 'tx-1', userId: 'user-1', scope: 'block-default', source: 'user'})
    h.deleteBlock('b1')
    h.clearTxContext()
    // The DELETE row_event still fires; ps_crud stays empty.
    expect(h.psCrud()).toHaveLength(0)
  })
})

describe('workspace-invariant triggers', () => {
  it('rejects local INSERT with dangling parent_id', () => {
    h.setTxContext({txId: 'tx-1', userId: 'user-1', scope: 'block-default', source: 'user'})
    expect(() => h.insertBlock({id: 'b1', parent_id: 'does-not-exist'})).toThrow(
      /parent must exist and share workspace_id/,
    )
  })

  it('rejects local INSERT with cross-workspace parent', () => {
    // Sync-seed a parent in ws1.
    h.insertBlock({id: 'parent', workspace_id: 'ws1'})
    // Local insert tries to attach a ws2 child to a ws1 parent.
    h.setTxContext({txId: 'tx-2', userId: 'user-1', scope: 'block-default', source: 'user'})
    expect(() =>
      h.insertBlock({id: 'child', workspace_id: 'ws2', parent_id: 'parent'}),
    ).toThrow(/parent must exist and share workspace_id/)
  })

  it('accepts local INSERT under a soft-deleted parent (storage-layer alignment)', () => {
    // Seed parent + soft-delete it (via local user write so triggers fire).
    h.setTxContext({txId: 'tx-1', userId: 'user-1', scope: 'block-default', source: 'user'})
    h.insertBlock({id: 'parent', workspace_id: 'ws1'})
    h.updateBlock('parent', {deleted: 1})
    // Fresh child under the tombstone — the local trigger does NOT filter
    // on deleted=0 (v4.24 alignment with server FK). Soft-deleted-parent
    // rejection is a kernel-mutator UX rule, not a storage invariant.
    expect(() =>
      h.insertBlock({id: 'child', workspace_id: 'ws1', parent_id: 'parent'}),
    ).not.toThrow()
    h.clearTxContext()
  })

  it('rejects local UPDATE that re-parents to a dangling id', () => {
    h.insertBlock({id: 'a', workspace_id: 'ws1'})
    h.insertBlock({id: 'b', workspace_id: 'ws1'})
    h.setTxContext({txId: 'tx-1', userId: 'user-1', scope: 'block-default', source: 'user'})
    expect(() =>
      h.updateBlock('b', {parent_id: 'ghost'}),
    ).toThrow(/parent must exist and share workspace_id/)
  })

  it("DOES NOT fire on sync-applied writes (source IS NULL gate)", () => {
    // Sync writes leave source = NULL. The trigger gate `source IS NOT NULL`
    // means a sync apply with a momentarily-dangling parent (e.g. parent
    // hasn't been hydrated yet under DEFERRABLE FK, server-side validated)
    // does not abort. Server FK is the canonical guarantee for sync; the
    // local trigger is for repo.tx writes only.
    expect(() => h.insertBlock({id: 'orphan', parent_id: 'not-yet-synced'})).not.toThrow()
  })

  it("DOES NOT fire on UI-state writes either, since UPDATE OF parent_id excludes other-column UI updates", () => {
    h.insertBlock({id: 'b1', workspace_id: 'ws1'})
    h.setTxContext({txId: 'tx-1', userId: 'user-1', scope: 'local-ui', source: 'local-ephemeral'})
    // Updating content (not parent_id/workspace_id) should not invoke the workspace-invariant UPDATE trigger.
    expect(() => h.updateBlock('b1', {content: 'x'})).not.toThrow()
    h.clearTxContext()
  })
})

// ============================================================================
// block_aliases trigger maintenance — the alias index that backs
// findBlockByAliasInWorkspace, parseReferences' lookupAliasTarget, and
// alias autocomplete. All three pre-trigger queries scanned the whole
// workspace; the index keeps them O(log n).
// ============================================================================

interface AliasRow {
  block_id: string
  workspace_id: string
  alias: string
  alias_lower: string
}

const aliasRows = (db: DatabaseSync): AliasRow[] =>
  db.prepare('SELECT block_id, workspace_id, alias, alias_lower FROM block_aliases ORDER BY block_id, alias').all() as unknown as AliasRow[]

describe('block_aliases trigger — INSERT', () => {
  it('extracts aliases from properties_json into block_aliases on insert', () => {
    h.insertBlock({id: 'b1', workspace_id: 'ws1', properties_json: '{"alias":["Foo","Bar"]}'})
    expect(aliasRows(h.db)).toEqual([
      {block_id: 'b1', workspace_id: 'ws1', alias: 'Bar', alias_lower: 'bar'},
      {block_id: 'b1', workspace_id: 'ws1', alias: 'Foo', alias_lower: 'foo'},
    ])
  })

  it('inserts no rows for blocks without an alias property', () => {
    h.insertBlock({id: 'b1', properties_json: '{"type":"page"}'})
    expect(aliasRows(h.db)).toEqual([])
  })

  it('inserts no rows for soft-deleted blocks', () => {
    h.insertBlock({id: 'b1', properties_json: '{"alias":["Foo"]}', deleted: 1})
    expect(aliasRows(h.db)).toEqual([])
  })

  it('skips non-string array elements defensively', () => {
    h.insertBlock({id: 'b1', properties_json: '{"alias":["Foo",42,null,"Bar"]}'})
    expect(aliasRows(h.db).map(r => r.alias)).toEqual(['Bar', 'Foo'])
  })
})

describe('block_aliases trigger — UPDATE', () => {
  it('replaces aliases when properties_json changes', () => {
    h.insertBlock({id: 'b1', properties_json: '{"alias":["Foo"]}'})
    h.updateBlock('b1', {properties_json: '{"alias":["Bar","Baz"]}'})
    expect(aliasRows(h.db).map(r => r.alias)).toEqual(['Bar', 'Baz'])
  })

  it('clears aliases on soft-delete (deleted 0 → 1)', () => {
    h.insertBlock({id: 'b1', properties_json: '{"alias":["Foo"]}'})
    h.updateBlock('b1', {deleted: 1})
    expect(aliasRows(h.db)).toEqual([])
  })

  it('repopulates aliases on tombstone restore (deleted 1 → 0)', () => {
    h.insertBlock({id: 'b1', properties_json: '{"alias":["Foo"]}', deleted: 1})
    expect(aliasRows(h.db)).toEqual([])
    h.updateBlock('b1', {deleted: 0})
    expect(aliasRows(h.db).map(r => r.alias)).toEqual(['Foo'])
  })

  it('does NOT fire on content-only edits', () => {
    h.insertBlock({id: 'b1', properties_json: '{"alias":["Foo"]}'})
    // The UPDATE trigger is gated on UPDATE OF properties_json/deleted/workspace_id.
    // A content-only edit must not churn block_aliases. We verify by inserting a
    // dup row before the update and checking it survives — the trigger would have
    // wiped it on fire.
    h.db.prepare('INSERT INTO block_aliases VALUES (?, ?, ?, ?)').run('b1', 'ws1', 'manual-tag', 'manual-tag')
    h.updateBlock('b1', {content: 'changed content'})
    const aliases = aliasRows(h.db).map(r => r.alias)
    expect(aliases).toContain('manual-tag')
  })
})

describe('block_aliases trigger — DELETE', () => {
  it('clears aliases on hard-delete', () => {
    h.insertBlock({id: 'b1', properties_json: '{"alias":["Foo"]}'})
    h.deleteBlock('b1')
    expect(aliasRows(h.db)).toEqual([])
  })
})

describe('block_aliases backfill', () => {
  it('populates the index from pre-existing blocks', () => {
    // Simulate the upgrade path: an existing user has rows in `blocks`
    // but the index hasn't been maintained yet. The triggers populated
    // block_aliases on each INSERT above, so we wipe the table first
    // to mimic the pre-index state.
    h.insertBlock({id: 'b1', workspace_id: 'ws1', properties_json: '{"alias":["Foo","Bar"]}'})
    h.insertBlock({id: 'b2', workspace_id: 'ws1', properties_json: '{"alias":["Baz"]}', deleted: 1})
    h.insertBlock({id: 'b3', workspace_id: 'ws2', properties_json: '{"alias":["Qux"]}'})
    h.db.exec('DELETE FROM block_aliases')

    h.db.exec(BACKFILL_BLOCK_ALIASES_SQL)

    expect(aliasRows(h.db)).toEqual([
      {block_id: 'b1', workspace_id: 'ws1', alias: 'Bar', alias_lower: 'bar'},
      {block_id: 'b1', workspace_id: 'ws1', alias: 'Foo', alias_lower: 'foo'},
      // b2 is soft-deleted → excluded
      {block_id: 'b3', workspace_id: 'ws2', alias: 'Qux', alias_lower: 'qux'},
    ])
  })

  it('is idempotent (safe to re-run on already-populated index)', () => {
    h.insertBlock({id: 'b1', properties_json: '{"alias":["Foo"]}'})
    h.db.exec(BACKFILL_BLOCK_ALIASES_SQL)
    expect(aliasRows(h.db)).toHaveLength(1)
  })

  describe('backfillBlockAliasesIfEmpty marker gate', () => {
    // The runner adapts node:sqlite's synchronous DatabaseSync to the
    // async {execute, getOptional} interface backfillBlockAliasesIfEmpty
    // expects in production (PowerSync's db handle).
    const runBackfill = async () => {
      await backfillBlockAliasesIfEmpty({
        execute: async (sql) => h.db.exec(sql),
        getOptional: async <T,>(sql: string) => {
          const row = h.db.prepare(sql).get() as T | undefined
          return row ?? null
        },
      })
    }
    const markerExists = (): boolean =>
      h.db
        .prepare(`SELECT 1 FROM client_schema_state WHERE key = '${ALIAS_BACKFILL_MARKER_KEY}'`)
        .get() !== undefined

    it('records the completion marker even when there are no aliases to backfill', async () => {
      // Empty workspace path: no blocks, nothing to insert into
      // block_aliases. Without the marker, the LIMIT 1 probe of
      // block_aliases would still report empty on every restart and
      // re-scan blocks indefinitely.
      expect(markerExists()).toBe(false)
      await runBackfill()
      expect(markerExists()).toBe(true)
      expect(aliasRows(h.db)).toHaveLength(0)
    })

    it('short-circuits on subsequent runs once the marker is present', async () => {
      await runBackfill()
      // Insert a block with aliases AFTER the marker is set; trigger
      // populates block_aliases as usual. Then drop block_aliases to
      // simulate "user removed every alias" and re-run the gate. The
      // marker should keep us from re-scanning, leaving block_aliases
      // empty (instead of repopulating from blocks).
      h.insertBlock({id: 'b1', workspace_id: 'ws1', properties_json: '{"alias":["Foo"]}'})
      h.db.exec('DELETE FROM block_aliases')
      await runBackfill()
      expect(aliasRows(h.db)).toHaveLength(0)
    })

    it('runs the backfill exactly once across multiple invocations', async () => {
      // Pre-existing blocks (upgrade path) — first call materialises
      // block_aliases, second call is a no-op gated by the marker.
      h.insertBlock({id: 'b1', workspace_id: 'ws1', properties_json: '{"alias":["Foo"]}'})
      h.db.exec('DELETE FROM block_aliases')

      await runBackfill()
      expect(aliasRows(h.db).map(r => r.alias)).toEqual(['Foo'])

      // Second call: the marker is set, so the SELECT short-circuits
      // before the BACKFILL SQL runs. We can verify by deleting the
      // alias row and checking it stays gone after the second call.
      h.db.exec('DELETE FROM block_aliases')
      await runBackfill()
      expect(aliasRows(h.db)).toHaveLength(0)
    })
  })
})

// ============================================================================
// block_references trigger maintenance — the directed-edge index that
// backs `backlinks.forBlock`. Mirrors the block_aliases tests above; the
// invariant is "live block's references_json edges == its rows in
// block_references".
// ============================================================================

interface ReferenceRow {
  source_id: string
  target_id: string
  workspace_id: string
  alias: string
}

const refRows = (db: DatabaseSync): ReferenceRow[] =>
  db
    .prepare('SELECT source_id, target_id, workspace_id, alias FROM block_references ORDER BY source_id, target_id, alias')
    .all() as unknown as ReferenceRow[]

const refsJson = (entries: Array<{ id: string; alias: string }>): string =>
  JSON.stringify(entries)

describe('block_references trigger — INSERT', () => {
  it('extracts references_json into block_references on insert', () => {
    h.insertBlock({
      id: 'src',
      workspace_id: 'ws1',
      references_json: refsJson([
        { id: 'tgt-a', alias: 'A' },
        { id: 'tgt-b', alias: 'B' },
      ]),
    })
    expect(refRows(h.db)).toEqual([
      { source_id: 'src', target_id: 'tgt-a', workspace_id: 'ws1', alias: 'A' },
      { source_id: 'src', target_id: 'tgt-b', workspace_id: 'ws1', alias: 'B' },
    ])
  })

  it('inserts no rows for blocks without references', () => {
    h.insertBlock({ id: 'src', references_json: '[]' })
    expect(refRows(h.db)).toEqual([])
  })

  it('inserts no rows for soft-deleted blocks', () => {
    h.insertBlock({
      id: 'src',
      references_json: refsJson([{ id: 'tgt', alias: 'A' }]),
      deleted: 1,
    })
    expect(refRows(h.db)).toEqual([])
  })

  it('keeps both edges when one source links to one target via two aliases', () => {
    // Same target reached by two different alias spellings — Roam-style
    // `[[Foo]]` and `[[foo]]` both resolved to the same block.
    h.insertBlock({
      id: 'src',
      references_json: refsJson([
        { id: 'tgt', alias: 'Foo' },
        { id: 'tgt', alias: 'foo' },
      ]),
    })
    expect(refRows(h.db).map(r => r.alias)).toEqual(['Foo', 'foo'])
  })

  it('skips defensively-malformed entries (missing $.id or $.alias, or wrong type)', () => {
    h.insertBlock({
      id: 'src',
      references_json: JSON.stringify([
        { id: 'tgt-a', alias: 'A' },
        { alias: 'no-id' },
        { id: 'tgt-b' },
        { id: 42, alias: 'numeric' },
        { id: 'tgt-c', alias: 'C' },
      ]),
    })
    expect(refRows(h.db).map(r => r.target_id)).toEqual(['tgt-a', 'tgt-c'])
  })
})

describe('block_references trigger — UPDATE', () => {
  it('replaces references when references_json changes', () => {
    h.insertBlock({
      id: 'src',
      references_json: refsJson([{ id: 'old', alias: 'O' }]),
    })
    h.updateBlock('src', {
      references_json: refsJson([
        { id: 'new-1', alias: 'N1' },
        { id: 'new-2', alias: 'N2' },
      ]),
    })
    expect(refRows(h.db).map(r => r.target_id)).toEqual(['new-1', 'new-2'])
  })

  it('clears references on soft-delete (deleted 0 → 1)', () => {
    h.insertBlock({
      id: 'src',
      references_json: refsJson([{ id: 'tgt', alias: 'A' }]),
    })
    h.updateBlock('src', { deleted: 1 })
    expect(refRows(h.db)).toEqual([])
  })

  it('repopulates references on tombstone restore (deleted 1 → 0)', () => {
    h.insertBlock({
      id: 'src',
      references_json: refsJson([{ id: 'tgt', alias: 'A' }]),
      deleted: 1,
    })
    expect(refRows(h.db)).toEqual([])
    h.updateBlock('src', { deleted: 0 })
    expect(refRows(h.db).map(r => r.target_id)).toEqual(['tgt'])
  })

  it('does NOT fire on content-only edits', () => {
    // The UPDATE trigger gates on UPDATE OF references_json/deleted/workspace_id.
    // A pure content edit must not churn block_references. We verify by
    // dropping in a bystander row before the update and checking it
    // survives the content edit (the trigger would have wiped it on fire).
    h.insertBlock({
      id: 'src',
      references_json: refsJson([{ id: 'tgt', alias: 'A' }]),
    })
    h.db
      .prepare('INSERT INTO block_references VALUES (?, ?, ?, ?)')
      .run('src', 'manual-tgt', 'ws1', 'manual-alias')
    h.updateBlock('src', { content: 'changed' })
    const targets = refRows(h.db).map(r => r.target_id)
    expect(targets).toContain('manual-tgt')
  })
})

describe('block_references trigger — DELETE', () => {
  it('clears references on hard-delete', () => {
    h.insertBlock({
      id: 'src',
      references_json: refsJson([{ id: 'tgt', alias: 'A' }]),
    })
    h.deleteBlock('src')
    expect(refRows(h.db)).toEqual([])
  })
})

describe('block_references backfill', () => {
  it('populates the index from pre-existing blocks', () => {
    // Simulate the upgrade path: existing user has rows in `blocks`
    // but the index hasn't been maintained yet. The triggers populate
    // block_references on each INSERT, so we wipe the table first
    // to mimic the pre-index state.
    h.insertBlock({
      id: 'src1',
      workspace_id: 'ws1',
      references_json: refsJson([
        { id: 'tgt-a', alias: 'A' },
        { id: 'tgt-b', alias: 'B' },
      ]),
    })
    h.insertBlock({
      id: 'src2-deleted',
      workspace_id: 'ws1',
      references_json: refsJson([{ id: 'tgt-c', alias: 'C' }]),
      deleted: 1,
    })
    h.insertBlock({
      id: 'src3',
      workspace_id: 'ws2',
      references_json: refsJson([{ id: 'tgt-d', alias: 'D' }]),
    })
    h.db.exec('DELETE FROM block_references')

    h.db.exec(BACKFILL_BLOCK_REFERENCES_SQL)

    expect(refRows(h.db)).toEqual([
      { source_id: 'src1', target_id: 'tgt-a', workspace_id: 'ws1', alias: 'A' },
      { source_id: 'src1', target_id: 'tgt-b', workspace_id: 'ws1', alias: 'B' },
      // src2-deleted is soft-deleted → excluded
      { source_id: 'src3', target_id: 'tgt-d', workspace_id: 'ws2', alias: 'D' },
    ])
  })

  it('is idempotent (safe to re-run on already-populated index)', () => {
    h.insertBlock({
      id: 'src',
      references_json: refsJson([{ id: 'tgt', alias: 'A' }]),
    })
    h.db.exec(BACKFILL_BLOCK_REFERENCES_SQL)
    expect(refRows(h.db)).toHaveLength(1)
  })

  describe('backfillBlockReferencesIfEmpty marker gate', () => {
    const runBackfill = async () => {
      await backfillBlockReferencesIfEmpty({
        execute: async (sql) => h.db.exec(sql),
        getOptional: async <T,>(sql: string) => {
          const row = h.db.prepare(sql).get() as T | undefined
          return row ?? null
        },
      })
    }
    const markerExists = (): boolean =>
      h.db
        .prepare(`SELECT 1 FROM client_schema_state WHERE key = '${BLOCK_REFERENCES_BACKFILL_MARKER_KEY}'`)
        .get() !== undefined

    it('records the completion marker even when there are no references to backfill', async () => {
      expect(markerExists()).toBe(false)
      await runBackfill()
      expect(markerExists()).toBe(true)
      expect(refRows(h.db)).toHaveLength(0)
    })

    it('short-circuits on subsequent runs once the marker is present', async () => {
      await runBackfill()
      // Insert a block with refs AFTER the marker is set; trigger
      // populates block_references as usual. Then drop the table to
      // simulate "user removed every reference" and re-run the gate.
      // The marker should keep us from re-scanning, leaving
      // block_references empty (instead of repopulating from blocks).
      h.insertBlock({
        id: 'src',
        references_json: refsJson([{ id: 'tgt', alias: 'A' }]),
      })
      h.db.exec('DELETE FROM block_references')
      await runBackfill()
      expect(refRows(h.db)).toHaveLength(0)
    })

    it('runs the backfill exactly once across multiple invocations', async () => {
      h.insertBlock({
        id: 'src',
        references_json: refsJson([{ id: 'tgt', alias: 'A' }]),
      })
      h.db.exec('DELETE FROM block_references')

      await runBackfill()
      expect(refRows(h.db).map(r => r.target_id)).toEqual(['tgt'])

      // Second call: marker is set, SQL short-circuits before the
      // BACKFILL runs. Verify by deleting the row and checking it
      // stays gone.
      h.db.exec('DELETE FROM block_references')
      await runBackfill()
      expect(refRows(h.db)).toHaveLength(0)
    })
  })
})
