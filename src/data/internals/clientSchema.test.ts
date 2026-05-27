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
 *   - source COALESCE: NULL → 'sync'; 'user' passes through
 *   - tx_id belt-and-suspenders: NULL when source is NULL, even with a
 *     stale tx_id left in tx_context
 *   - soft-delete UPDATE emits kind='soft-delete'
 *   - upload-routing triggers fire on every repo.tx write (source IS NOT NULL),
 *     and skip sync-applied writes (source = NULL)
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
  CREATE_WORKSPACE_MEMBERS_INDEX_SQL,
  CREATE_WORKSPACE_MEMBERS_TABLE_SQL,
} from '@/data/workspaceSchema'
import {
  ALIAS_BACKFILL_MARKER_KEY,
  ANALYZE_MARKER_KEY,
  ANALYZE_REFRESH_INTERVAL_MS,
  BACKFILL_BLOCK_ALIASES_SQL,
  BACKFILL_BLOCKS_FTS_SQL,
  BLOCKS_FTS_BACKFILL_MARKER_KEY,
  CLIENT_SCHEMA_STATEMENTS,
  CLIENT_SCHEMA_TRIGGER_NAMES,
  COUNT_LOCAL_EPHEMERAL_BACKFILL_PENDING_SQL,
  LOCAL_EPHEMERAL_BACKFILL_MARKER_KEY,
  backfillBlockAliasesIfEmpty,
  backfillBlocksFtsIfEmpty,
  backfillLocalEphemeralUploadsIfPending,
  runAnalyzeIfDue,
} from './clientSchema'

interface TestDb {
  db: DatabaseSync
  setTxContext: (ctx: { txId?: string | null; txSeq?: number | null; userId?: string | null; scope?: string | null; source?: string | null }) => void
  clearTxContext: () => void
  insertBlock: (overrides?: Partial<BlockInsert>) => void
  insertWorkspaceMember: (overrides?: Partial<WorkspaceMemberInsert>) => void
  updateBlock: (id: string, set: Record<string, unknown>) => void
  deleteBlock: (id: string) => void
  rowEvents: () => Array<RowEventRow>
  psCrud: () => Array<{ id: number; data: string; tx_id: number | null }>
  rowEventCount: () => number
}

interface WorkspaceMemberInsert {
  id: string
  workspace_id: string
  user_id: string
  role: 'owner' | 'editor' | 'viewer'
  create_time: number
}

const defaultMember: WorkspaceMemberInsert = {
  id: 'm-ws1-user-1',
  workspace_id: 'ws1',
  user_id: 'user-1',
  role: 'owner',
  create_time: 1700000000000,
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
  reference_target_id: string | null
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
  reference_target_id: null,
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

  // workspace_members is a sibling table that the local-ephemeral
  // backfill consults to scope uploads to writable workspaces. Created
  // here so tests can seed membership rows; production builds the same
  // schema from src/data/workspaceSchema.ts.
  db.exec(CREATE_WORKSPACE_MEMBERS_TABLE_SQL)
  db.exec(CREATE_WORKSPACE_MEMBERS_INDEX_SQL)

  for (const stmt of CLIENT_SCHEMA_STATEMENTS) {
    db.exec(stmt)
  }

  const columnNames = BLOCK_STORAGE_COLUMNS.map(c => c.name)
  const insertStmt = db.prepare(
    `INSERT INTO blocks (${columnNames.join(',')}) VALUES (${columnNames.map(() => '?').join(',')})`,
  )
  const insertMemberStmt = db.prepare(
    'INSERT INTO workspace_members (id, workspace_id, user_id, role, create_time) VALUES (?, ?, ?, ?, ?)',
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
    insertWorkspaceMember: (overrides = {}) => {
      const row = {...defaultMember, ...overrides}
      insertMemberStmt.run(row.id, row.workspace_id, row.user_id, row.role, row.create_time)
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
  it('creates the documented set of client-schema triggers', () => {
    // CLIENT_SCHEMA_TRIGGER_NAMES covers triggers on `blocks` (the
    // bulk of them — row_events, upload routing, workspace
    // invariants, side-index maintenance) AND on `block_aliases`
    // (the uniqueness-enforcement trigger). Query against both
    // tables so the inventory test catches additions on either side.
    const triggers = (h.db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('blocks', 'block_aliases') ORDER BY name")
      .all() as Array<{name: string}>)
      .map(r => r.name)
    expect(triggers.sort()).toEqual([...CLIENT_SCHEMA_TRIGGER_NAMES].sort())
    expect(triggers).toHaveLength(CLIENT_SCHEMA_TRIGGER_NAMES.length)
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

  it('creates ps_crud_rejected with the columns the upload handler writes', () => {
    // ps_crud_rejected quarantines uploads the server permanently
    // refused (FK violation, RLS denial, 4xx). The upload handler in
    // src/services/powersync.ts depends on this exact column set when
    // it records a rejection; renaming or dropping any of these
    // columns breaks rejection recording.
    const columns = (h.db
      .prepare("PRAGMA table_info(ps_crud_rejected)")
      .all() as Array<{name: string; type: string; notnull: number}>)
      .map(c => ({name: c.name, type: c.type, notnull: c.notnull}))
    expect(columns).toEqual([
      {name: 'id', type: 'INTEGER', notnull: 0},
      {name: 'original_id', type: 'INTEGER', notnull: 1},
      {name: 'tx_id', type: 'INTEGER', notnull: 1},
      {name: 'data', type: 'TEXT', notnull: 1},
      {name: 'error_code', type: 'TEXT', notnull: 0},
      {name: 'error_message', type: 'TEXT', notnull: 0},
      {name: 'rejected_at', type: 'INTEGER', notnull: 1},
    ])
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

  it("tags source='user' for UI-state writes (no separate local-ephemeral sink)", () => {
    // UI-state writes used to land with source='local-ephemeral' and
    // bypass the upload triggers. Phase 2 dropped that distinction —
    // every repo.tx write is tagged 'user'; the rejection quarantine
    // catches anything the server refuses.
    h.setTxContext({txId: 'tx-B', userId: 'user-1', scope: 'local-ui', source: 'user'})
    h.insertBlock({id: 'b2'})
    h.clearTxContext()
    expect(h.rowEvents()[0]).toMatchObject({source: 'user', tx_id: 'tx-B'})
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

  it('forwards only changed columns in UPDATE PATCH payloads', () => {
    h.insertBlock({
      id: 'b1',
      content: 'old',
      properties_json: '{"alias":["Old"]}',
      references_json: '[{"id":"target","alias":"Target"}]',
    })
    h.setTxContext({txId: 'tx-1', txSeq: 5151, userId: 'user-1', scope: 'block-default', source: 'user'})
    h.updateBlock('b1', {
      content: 'new',
      updated_at: 1700000999000,
      updated_by: 'user-2',
    })
    h.clearTxContext()

    const payload = JSON.parse(h.psCrud()[0].data)
    expect(payload).toMatchObject({op: 'PATCH', type: 'blocks', id: 'b1'})
    expect(payload.data).toEqual({
      content: 'new',
      updated_at: 1700000999000,
      updated_by: 'user-2',
    })
  })

  it('keeps explicit nulls in changed UPDATE PATCH payloads', () => {
    h.insertBlock({id: 'b1', parent_id: 'old-parent'})
    h.setTxContext({txId: 'tx-1', txSeq: 5151, userId: 'user-1', scope: 'block-default', source: 'user'})
    h.updateBlock('b1', {parent_id: null})
    h.clearTxContext()

    const payload = JSON.parse(h.psCrud()[0].data)
    expect(payload.data).toEqual({parent_id: null})
  })

  it('does not queue an empty PATCH for no-op UPDATE statements', () => {
    h.insertBlock({id: 'b1', content: 'same'})
    h.setTxContext({txId: 'tx-1', txSeq: 5151, userId: 'user-1', scope: 'block-default', source: 'user'})
    h.updateBlock('b1', {content: 'same'})
    h.clearTxContext()

    expect(h.psCrud()).toHaveLength(0)
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

  it("forwards UI-state writes the same way as content writes", () => {
    // Phase 2: every repo.tx write enqueues. The UI-state scope identity
    // still matters for undo bucketing and schema validation, but the
    // upload-routing trigger no longer special-cases it.
    h.setTxContext({txId: 'tx-2', txSeq: 200, userId: 'user-1', scope: 'local-ui', source: 'user'})
    h.insertBlock({id: 'b2'})
    h.clearTxContext()
    const crud = h.psCrud()
    expect(crud).toHaveLength(1)
    expect(crud[0].tx_id).toBe(200)
    expect(JSON.parse(crud[0].data)).toMatchObject({op: 'PUT', type: 'blocks', id: 'b2'})
  })

  it("does NOT forward sync-applied writes (source IS NULL gate)", () => {
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

  it('rejects local INSERT under a soft-deleted parent (storage-layer enforcement)', () => {
    // Seed parent + soft-delete it (via local user write so triggers fire).
    h.setTxContext({txId: 'tx-1', userId: 'user-1', scope: 'block-default', source: 'user'})
    h.insertBlock({id: 'parent', workspace_id: 'ws1'})
    h.updateBlock('parent', {deleted: 1})
    // Fresh child under the tombstone — `blocks_parent_not_deleted_check_insert`
    // RAISEs so the rule is enforced at the storage layer, independent
    // of which write path arrived. The server FK still accepts soft-
    // deleted parents (§4.1.1); sync-applied writes bypass via the
    // `source IS NOT NULL` gate.
    expect(() =>
      h.insertBlock({id: 'child', workspace_id: 'ws1', parent_id: 'parent'}),
    ).toThrow(/parent_deleted/)
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

  it("DOES NOT fire on UI-state writes when the columns it gates on are unchanged", () => {
    // UI-state writes carry source='user' like any other repo.tx write,
    // so the source IS NOT NULL gate IS satisfied — but the trigger is
    // declared UPDATE OF parent_id, workspace_id, so a content-only edit
    // never even fires the BEFORE-UPDATE check.
    h.insertBlock({id: 'b1', workspace_id: 'ws1'})
    h.setTxContext({txId: 'tx-1', userId: 'user-1', scope: 'local-ui', source: 'user'})
    expect(() => h.updateBlock('b1', {content: 'x'})).not.toThrow()
    h.clearTxContext()
  })
})

describe('parent-not-deleted triggers', () => {
  it('rejects local INSERT of a live child under a tombstoned parent', () => {
    h.setTxContext({txId: 'tx-1', userId: 'user-1', scope: 'block-default', source: 'user'})
    h.insertBlock({id: 'p', workspace_id: 'ws1'})
    h.updateBlock('p', {deleted: 1})
    expect(() => h.insertBlock({id: 'c', workspace_id: 'ws1', parent_id: 'p'})).toThrow(
      /parent_deleted/,
    )
    h.clearTxContext()
  })

  it('rejects local UPDATE that re-parents an existing block onto a tombstone', () => {
    h.insertBlock({id: 'p', workspace_id: 'ws1'})
    h.insertBlock({id: 'q', workspace_id: 'ws1'})
    h.setTxContext({txId: 'tx-1', userId: 'user-1', scope: 'block-default', source: 'user'})
    h.updateBlock('p', {deleted: 1})
    expect(() => h.updateBlock('q', {parent_id: 'p'})).toThrow(/parent_deleted/)
    h.clearTxContext()
  })

  it('rejects local UPDATE that restores a tombstoned child under a tombstoned parent', () => {
    h.insertBlock({id: 'p', workspace_id: 'ws1'})
    h.insertBlock({id: 'c', workspace_id: 'ws1', parent_id: 'p'})
    h.setTxContext({txId: 'tx-1', userId: 'user-1', scope: 'block-default', source: 'user'})
    h.updateBlock('c', {deleted: 1})
    h.updateBlock('p', {deleted: 1})
    expect(() => h.updateBlock('c', {deleted: 0})).toThrow(/parent_deleted/)
    h.clearTxContext()
  })

  it('allows soft-delete UPDATE (deleted 0→1) regardless of parent state', () => {
    h.insertBlock({id: 'p', workspace_id: 'ws1'})
    h.insertBlock({id: 'c', workspace_id: 'ws1', parent_id: 'p'})
    h.setTxContext({txId: 'tx-1', userId: 'user-1', scope: 'block-default', source: 'user'})
    h.updateBlock('p', {deleted: 1})
    // Cascading soft-delete: child being tombstoned under an already-
    // tombstoned parent must succeed (this is how `softDeleteSubtree`
    // works after the parent is marked).
    expect(() => h.updateBlock('c', {deleted: 1})).not.toThrow()
    h.clearTxContext()
  })

  it('allows local INSERT/UPDATE when the parent is live', () => {
    h.insertBlock({id: 'p', workspace_id: 'ws1'})
    h.setTxContext({txId: 'tx-1', userId: 'user-1', scope: 'block-default', source: 'user'})
    expect(() => h.insertBlock({id: 'c', workspace_id: 'ws1', parent_id: 'p'})).not.toThrow()
    expect(() => h.updateBlock('c', {content: 'edited'})).not.toThrow()
    h.clearTxContext()
  })

  it('DOES NOT fire on sync-applied writes (source IS NULL gate)', () => {
    // Seed both blocks via sync (no tx_context). A sync apply that
    // delivers a live child after the parent's tombstone arrives must
    // not abort — cross-client tombstone ordering is permitted, mirrors
    // the workspace-invariant trigger's policy.
    h.insertBlock({id: 'p', workspace_id: 'ws1', deleted: 1})
    expect(() => h.insertBlock({id: 'c', workspace_id: 'ws1', parent_id: 'p'})).not.toThrow()
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

// ============================================================================
// blocks_fts trigger maintenance — the FTS5 trigram index backing
// core.searchByContent. It mirrors live, non-empty blocks.content rows.
// ============================================================================

interface BlocksFtsRow {
  block_id: string
  workspace_id: string
  content: string
}

const blocksFtsRows = (db: DatabaseSync): BlocksFtsRow[] =>
  db.prepare('SELECT block_id, workspace_id, content FROM blocks_fts ORDER BY block_id').all() as unknown as BlocksFtsRow[]

describe('blocks_fts trigger — INSERT', () => {
  it('indexes live non-empty block content on insert', () => {
    h.insertBlock({id: 'b1', workspace_id: 'ws1', content: 'Hello World'})
    expect(blocksFtsRows(h.db)).toEqual([
      {block_id: 'b1', workspace_id: 'ws1', content: 'Hello World'},
    ])
  })

  it('does not index empty-content or soft-deleted blocks', () => {
    h.insertBlock({id: 'empty', content: ''})
    h.insertBlock({id: 'deleted', content: 'Hidden', deleted: 1})
    expect(blocksFtsRows(h.db)).toEqual([])
  })
})

describe('blocks_fts trigger — UPDATE', () => {
  it('replaces the indexed row when content changes', () => {
    h.insertBlock({id: 'b1', content: 'old content'})
    h.updateBlock('b1', {content: 'new content'})
    expect(blocksFtsRows(h.db)).toEqual([
      {block_id: 'b1', workspace_id: 'ws1', content: 'new content'},
    ])
  })

  it('clears the indexed row when content becomes empty', () => {
    h.insertBlock({id: 'b1', content: 'old content'})
    h.updateBlock('b1', {content: ''})
    expect(blocksFtsRows(h.db)).toEqual([])
  })

  it('clears content on soft-delete and repopulates on restore', () => {
    h.insertBlock({id: 'b1', content: 'restorable'})
    h.updateBlock('b1', {deleted: 1})
    expect(blocksFtsRows(h.db)).toEqual([])
    h.updateBlock('b1', {deleted: 0})
    expect(blocksFtsRows(h.db)).toEqual([
      {block_id: 'b1', workspace_id: 'ws1', content: 'restorable'},
    ])
  })

  it('tracks workspace changes without duplicating rows', () => {
    h.insertBlock({id: 'b1', workspace_id: 'ws1', content: 'portable'})
    h.updateBlock('b1', {workspace_id: 'ws2'})
    expect(blocksFtsRows(h.db)).toEqual([
      {block_id: 'b1', workspace_id: 'ws2', content: 'portable'},
    ])
  })
})

describe('blocks_fts trigger — DELETE', () => {
  it('clears the indexed row on hard-delete', () => {
    h.insertBlock({id: 'b1', content: 'soon gone'})
    h.deleteBlock('b1')
    expect(blocksFtsRows(h.db)).toEqual([])
  })
})

describe('blocks_fts backfill', () => {
  it('populates the index from pre-existing live non-empty blocks', () => {
    h.insertBlock({id: 'b1', workspace_id: 'ws1', content: 'Alpha text'})
    h.insertBlock({id: 'b2', workspace_id: 'ws1', content: 'Deleted text', deleted: 1})
    h.insertBlock({id: 'b3', workspace_id: 'ws2', content: ''})
    h.insertBlock({id: 'b4', workspace_id: 'ws2', content: 'Beta text'})
    h.db.exec('DELETE FROM blocks_fts')

    h.db.exec(BACKFILL_BLOCKS_FTS_SQL)

    expect(blocksFtsRows(h.db)).toEqual([
      {block_id: 'b1', workspace_id: 'ws1', content: 'Alpha text'},
      {block_id: 'b4', workspace_id: 'ws2', content: 'Beta text'},
    ])
  })

  it('is idempotent when rerun after trigger-populated rows already exist', () => {
    h.insertBlock({id: 'b1', workspace_id: 'ws1', content: 'Alpha text'})
    h.db.exec(BACKFILL_BLOCKS_FTS_SQL)
    expect(blocksFtsRows(h.db)).toEqual([
      {block_id: 'b1', workspace_id: 'ws1', content: 'Alpha text'},
    ])
  })

  describe('backfillBlocksFtsIfEmpty marker gate', () => {
    const runBackfill = async () => {
      await backfillBlocksFtsIfEmpty({
        execute: async (sql) => h.db.exec(sql),
        getOptional: async <T,>(sql: string) => {
          const row = h.db.prepare(sql).get() as T | undefined
          return row ?? null
        },
      })
    }
    const markerExists = (): boolean =>
      h.db
        .prepare(`SELECT 1 FROM client_schema_state WHERE key = '${BLOCKS_FTS_BACKFILL_MARKER_KEY}'`)
        .get() !== undefined

    it('records completion even when there is no content to backfill', async () => {
      expect(markerExists()).toBe(false)
      await runBackfill()
      expect(markerExists()).toBe(true)
      expect(blocksFtsRows(h.db)).toHaveLength(0)
    })

    it('runs the backfill exactly once across multiple invocations', async () => {
      h.insertBlock({id: 'b1', workspace_id: 'ws1', content: 'Alpha text'})
      h.db.exec('DELETE FROM blocks_fts')

      await runBackfill()
      expect(blocksFtsRows(h.db).map(r => r.block_id)).toEqual(['b1'])

      h.db.exec('DELETE FROM blocks_fts')
      await runBackfill()
      expect(blocksFtsRows(h.db)).toHaveLength(0)
    })
  })
})

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

describe('backfillLocalEphemeralUploadsIfPending', () => {
  // Adapt node:sqlite (sync) to the async {execute, getOptional} the
  // bootstrap helper expects. Forwards SQL params to db.prepare(sql).run.
  const runBackfill = async (
    txSeq = 1_700_000_000_000,
    userId = 'user-1',
  ) => {
    await backfillLocalEphemeralUploadsIfPending({
      execute: async (sql, params) => {
        if (params && params.length > 0) {
          h.db.prepare(sql).run(...(params as Array<string | number | null>))
        } else {
          h.db.exec(sql)
        }
      },
      getOptional: async <T,>(sql: string, params?: unknown[]) => {
        const row = params && params.length > 0
          ? h.db.prepare(sql).get(...(params as Array<string | number | null>)) as T | undefined
          : h.db.prepare(sql).get() as T | undefined
        return row ?? null
      },
    }, () => txSeq, userId)
  }

  const markerExists = (): boolean =>
    h.db
      .prepare(`SELECT 1 FROM client_schema_state WHERE key = '${LOCAL_EPHEMERAL_BACKFILL_MARKER_KEY}'`)
      .get() !== undefined

  const pendingCount = (userId = 'user-1'): number =>
    (h.db.prepare(COUNT_LOCAL_EPHEMERAL_BACKFILL_PENDING_SQL).get(userId) as {n: number}).n

  /** Production state on upgrade day: rows whose original write was
   *  `source: 'local-ephemeral'` (under the old routing) NEVER landed
   *  in ps_crud because the old trigger gate was `source = 'user'`.
   *  In this test environment we're running the NEW trigger gate
   *  (`source IS NOT NULL`), so we can't actually re-create that
   *  history. Instead: snapshot ps_crud, perform the write under the
   *  old source value, then delete just the trigger-emitted row(s) —
   *  leaving any previously-enqueued rows in place. The end state
   *  matches an upgrade user: row + its local-ephemeral row_event,
   *  nothing new in the upload queue. */
  const simulateOldLocalEphemeralInsert = (overrides: Partial<{id: string; workspace_id: string; parent_id: string | null}> = {}) => {
    const maxBefore = (h.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM ps_crud').get() as {m: number}).m
    h.setTxContext({txId: `tx-${overrides.id ?? 'b'}`, txSeq: 1, userId: 'user-1', scope: 'local-ui', source: 'local-ephemeral'})
    h.insertBlock(overrides)
    h.clearTxContext()
    h.db.prepare('DELETE FROM ps_crud WHERE id > ?').run(maxBefore)
  }

  it('records the completion marker even when there is nothing to enqueue', async () => {
    // Fresh device (no row_events to scan) takes the empty path — the
    // marker still gets written so subsequent startups skip the scan.
    expect(markerExists()).toBe(false)
    expect(pendingCount()).toBe(0)
    await runBackfill()
    expect(markerExists()).toBe(true)
    expect(h.psCrud()).toHaveLength(0)
  })

  it("enqueues blocks whose latest row_events.source is 'local-ephemeral' and skips already-queued ones", async () => {
    h.insertWorkspaceMember()
    simulateOldLocalEphemeralInsert({id: 'ui-1', workspace_id: 'ws1'})
    simulateOldLocalEphemeralInsert({id: 'ui-2', workspace_id: 'ws1', parent_id: 'ui-1'})

    // A regular doc write uploads via the (new) trigger and IS already
    // in ps_crud — the backfill must not double-enqueue it.
    h.setTxContext({txId: 'tx-doc', txSeq: 11, userId: 'user-1', scope: 'block-default', source: 'user'})
    h.insertBlock({id: 'doc-1', workspace_id: 'ws1'})
    h.clearTxContext()

    expect(h.psCrud()).toHaveLength(1) // doc-1 from trigger
    expect(pendingCount()).toBe(2)     // ui-1 + ui-2 from backfill

    await runBackfill(99_999)

    const crud = h.psCrud()
    expect(crud).toHaveLength(3)
    const backfilledIds = crud
      .filter(r => r.tx_id === 99_999)
      .map(r => JSON.parse(r.data).id)
      .sort()
    expect(backfilledIds).toEqual(['ui-1', 'ui-2'])
    // All backfilled rows share the same tx_id so they ship as one
    // server-side transaction; the DEFERRABLE composite FK then accepts
    // the parent-child chain regardless of insertion order.
  })

  it('skips a stale row whose latest event has since become a sync apply', async () => {
    // The row was first written local-ephemeral, then an incoming sync
    // applied a server-side change to it. That means the server DOES
    // have the row now, so the backfill should not re-upload it.
    h.insertWorkspaceMember()
    simulateOldLocalEphemeralInsert({id: 'b1', workspace_id: 'ws1'})
    // Sync apply: source is NULL so the row_events trigger tags 'sync'.
    h.updateBlock('b1', {content: 'from-other-device'})

    expect(pendingCount()).toBe(0)
    await runBackfill()
    expect(h.psCrud()).toHaveLength(0)
  })

  it('is idempotent: a second call after the marker is set is a no-op', async () => {
    h.insertWorkspaceMember()
    simulateOldLocalEphemeralInsert({id: 'b1', workspace_id: 'ws1'})

    await runBackfill(42)
    expect(h.psCrud()).toHaveLength(1)
    expect(markerExists()).toBe(true)

    // Add a fresh stale row AFTER the marker. The second call should
    // short-circuit on the marker and leave the new row un-enqueued.
    simulateOldLocalEphemeralInsert({id: 'b2', workspace_id: 'ws1'})

    await runBackfill(43)
    expect(h.psCrud()).toHaveLength(1)
  })

  it("emits PATCH so the orchestrator's full-row upsert can overwrite a divergent server row", async () => {
    // The trigger INSERT path emits PUT, which the orchestrator routes
    // through `applyBlockCreates` -> `upsert(..., {ignoreDuplicates:true})`.
    // That semantic is correct for bootstrap (a fresh client's deterministic-
    // id PUT mustn't clobber a row another device has already customized).
    //
    // For the backfill it is WRONG. By definition the backfill targets
    // local rows that the server either lacks or has in a stale form
    // (the v3 "no sync echo" filter is necessary but not sufficient —
    // observed on ff-vlad-dev where 8 content blocks had a successful
    // 'user' upload followed by silent local-ephemeral edits that never
    // landed). Re-emitting them as PUT becomes a no-op against the
    // existing-but-stale server row; the divergence is preserved.
    //
    // PATCH routes through `applyBlockPatches` which loads the full
    // current local row and upserts it with `{onConflict:'id'}` (no
    // ignoreDuplicates). For a missing server row that's an INSERT; for
    // an existing-but-stale row it's a full replace — local wins, which
    // is the right semantic for recovery.
    h.insertWorkspaceMember()
    simulateOldLocalEphemeralInsert({id: 'stale-1', workspace_id: 'ws1'})

    h.setTxContext({txId: 'tx-doc', txSeq: 2, userId: 'user-1', scope: 'block-default', source: 'user'})
    h.insertBlock({id: 'live-1', workspace_id: 'ws1', content: 'live-content'})
    h.clearTxContext()

    await runBackfill()

    const triggerEnvelope = JSON.parse(h.psCrud().find(r => JSON.parse(r.data).id === 'live-1')!.data)
    const backfillEnvelope = JSON.parse(h.psCrud().find(r => JSON.parse(r.data).id === 'stale-1')!.data)
    expect(triggerEnvelope.op).toBe('PUT')
    expect(backfillEnvelope.op).toBe('PATCH')
    // Backfill envelope still carries the full row payload — `applyBlockPatches`
    // re-reads local state regardless, but a complete payload keeps the
    // rejection-quarantine log readable (the row's full state at queue time).
    expect(Object.keys(triggerEnvelope.data).sort()).toEqual(Object.keys(backfillEnvelope.data).sort())
  })

  describe('workspace-membership filter', () => {
    // The filter exists because the local DB can hold stale UI-state
    // blocks for workspaces the user no longer (or never did) belong
    // to — leftovers from a workspace the user was a member of and got
    // removed from, or test setups. Without filtering, those rows go
    // into the same atomic ps_crud tx as the user's legit own-workspace
    // backfill rows; one RLS denial then tanks the whole batch and
    // every well-formed row gets quarantined alongside the bad apples.
    // See ps_crud_rejected analysis on 2026-05-25 for the field
    // observation that motivated this filter.

    it('skips blocks in workspaces the user is not a member of', async () => {
      // user-1 owns ws1 only. ws-foreign has a block but no member row.
      h.insertWorkspaceMember({id: 'm-ws1', workspace_id: 'ws1', user_id: 'user-1', role: 'owner'})
      simulateOldLocalEphemeralInsert({id: 'own-1', workspace_id: 'ws1'})
      simulateOldLocalEphemeralInsert({id: 'foreign-1', workspace_id: 'ws-foreign'})

      await runBackfill(7777)
      const ids = h.psCrud().map(r => JSON.parse(r.data).id).sort()
      expect(ids).toEqual(['own-1'])
    })

    it("skips blocks in workspaces where the user's role is 'viewer'", async () => {
      // A viewer can read sync'd blocks but can't write — any local
      // UI-state writes targeting that workspace would get RLS-denied.
      // Skip them at the backfill stage so they don't poison the batch.
      h.insertWorkspaceMember({id: 'm-ws-r', workspace_id: 'ws-read', user_id: 'user-1', role: 'viewer'})
      h.insertWorkspaceMember({id: 'm-ws1', workspace_id: 'ws1', user_id: 'user-1', role: 'editor'})
      simulateOldLocalEphemeralInsert({id: 'own-1', workspace_id: 'ws1'})
      simulateOldLocalEphemeralInsert({id: 'viewer-only-1', workspace_id: 'ws-read'})

      await runBackfill(7778)
      const ids = h.psCrud().map(r => JSON.parse(r.data).id).sort()
      expect(ids).toEqual(['own-1'])
    })

    it("includes blocks where the user's role is 'editor'", async () => {
      h.insertWorkspaceMember({id: 'm-ws-e', workspace_id: 'ws-edit', user_id: 'user-1', role: 'editor'})
      simulateOldLocalEphemeralInsert({id: 'edit-1', workspace_id: 'ws-edit'})

      await runBackfill(7779)
      const ids = h.psCrud().map(r => JSON.parse(r.data).id).sort()
      expect(ids).toEqual(['edit-1'])
    })

    it("PENDING count agrees with the actual enqueue", async () => {
      // pendingCount() and the INSERT must use the same filter — otherwise
      // diagnostics ("backfilling N rows…") would diverge from reality.
      h.insertWorkspaceMember({id: 'm-ws1', workspace_id: 'ws1', user_id: 'user-1', role: 'owner'})
      simulateOldLocalEphemeralInsert({id: 'own-a', workspace_id: 'ws1'})
      simulateOldLocalEphemeralInsert({id: 'own-b', workspace_id: 'ws1'})
      simulateOldLocalEphemeralInsert({id: 'foreign-x', workspace_id: 'ws-foreign'})
      simulateOldLocalEphemeralInsert({id: 'foreign-y', workspace_id: 'ws-foreign'})

      expect(pendingCount('user-1')).toBe(2)
      await runBackfill(7780)
      expect(h.psCrud()).toHaveLength(2)
    })

    it("filters by the PASSED user_id, not by other members' rows", async () => {
      // ws1 has two members; user-1 is owner and is the one running the
      // backfill on this device. user-2 happens to also be a member, but
      // their membership row should not let user-1 write to ws-other.
      h.insertWorkspaceMember({id: 'm-ws1-u1', workspace_id: 'ws1', user_id: 'user-1', role: 'owner'})
      h.insertWorkspaceMember({id: 'm-ws-other-u2', workspace_id: 'ws-other', user_id: 'user-2', role: 'owner'})
      simulateOldLocalEphemeralInsert({id: 'own-1', workspace_id: 'ws1'})
      simulateOldLocalEphemeralInsert({id: 'other-1', workspace_id: 'ws-other'})

      await runBackfill(7781, 'user-1')
      const ids = h.psCrud().map(r => JSON.parse(r.data).id).sort()
      expect(ids).toEqual(['own-1'])
    })
  })

  describe('"no sync echo" heuristic', () => {
    // v2 used "latest event source = local-ephemeral" as the
    // needs-upload signal. That missed blocks whose history was
    // local-ephemeral *then* later 'user' writes that never actually
    // landed server-side — common when an early-Phase-2 write
    // enqueued but its parent chain wasn't there yet, so the upload
    // FK-failed and (under per-tx orchestration) only the single tx
    // was quarantined. The phantom-on-local-only ancestor then trips
    // the next backfill's FK because it's not in the candidate set.
    //
    // v3 includes any block with local-ephemeral history AND no
    // 'sync' event (i.e., the server has never echoed it back). A
    // sync echo proves the row landed; absence is the only signal we
    // have from the client side that it may still be missing.

    it("includes a block whose latest event is 'user' if it has no sync echo yet", async () => {
      h.insertWorkspaceMember()
      // pre-Phase-2 history: row was created/edited as local-ephemeral
      simulateOldLocalEphemeralInsert({id: 'phantom', workspace_id: 'ws1'})
      // post-Phase-2: a later 'user' edit emits a PATCH ps_crud entry,
      // but suppose that upload silently never landed (FK on a missing
      // ancestor, then the rejection bookkeeping or some other miss).
      // From the local row_events alone, the latest source is 'user'
      // but there's still no 'sync' echo.
      h.setTxContext({txId: 'tx-u', txSeq: 9, userId: 'user-1', scope: 'block-default', source: 'user'})
      h.updateBlock('phantom', {content: 'edited-locally', updated_at: 1700000010000})
      h.clearTxContext()
      // Drop the trigger-emitted ps_crud entry to mimic the "upload
      // happened but row is still missing server-side" state.
      h.db.exec(`DELETE FROM ps_crud WHERE json_extract(data, '$.id') = 'phantom'`)
      expect(h.psCrud()).toHaveLength(0)

      await runBackfill(9100)
      const ids = h.psCrud().map(r => JSON.parse(r.data).id).sort()
      expect(ids).toEqual(['phantom'])
    })

    it('excludes a block once any sync event has fired (server has it)', async () => {
      h.insertWorkspaceMember()
      simulateOldLocalEphemeralInsert({id: 'landed', workspace_id: 'ws1'})
      // Any 'sync' event proves the row exists server-side. Even if a
      // later local 'user' edit follows, we don't need to re-upload —
      // the trigger has already enqueued that PATCH separately.
      h.updateBlock('landed', {content: 'from-server'})  // source NULL → 'sync'
      h.setTxContext({txId: 'tx-u', txSeq: 10, userId: 'user-1', scope: 'block-default', source: 'user'})
      h.updateBlock('landed', {content: 'local-edit-after-sync'})
      h.clearTxContext()

      await runBackfill(9200)
      const backfilled = h.psCrud()
        .filter(r => r.tx_id === 9200)
        .map(r => JSON.parse(r.data).id)
      expect(backfilled).toEqual([])
    })

    it("excludes a block whose history has NO local-ephemeral event", async () => {
      // Post-Phase-2 'user'-only history → the upload trigger already
      // handles this block. No backfill needed.
      h.insertWorkspaceMember()
      h.setTxContext({txId: 'tx-u', txSeq: 11, userId: 'user-1', scope: 'block-default', source: 'user'})
      h.insertBlock({id: 'born-user', workspace_id: 'ws1'})
      h.clearTxContext()
      // The trigger inserted a ps_crud entry for born-user; we don't
      // want the backfill to duplicate it.
      const beforeIds = h.psCrud().map(r => JSON.parse(r.data).id)
      expect(beforeIds).toEqual(['born-user'])

      await runBackfill(9300)
      const backfilled = h.psCrud()
        .filter(r => r.tx_id === 9300)
        .map(r => JSON.parse(r.data).id)
      expect(backfilled).toEqual([])
    })
  })
})

describe('runAnalyzeIfDue', () => {
  // Adapter that records every `execute` call so the assertions can
  // tell whether ANALYZE actually ran without poking at sqlite_stat1
  // (which depends on how much data was indexed).
  const buildRunner = (now: () => number) => {
    const executed: string[] = []
    const run = async () => {
      const ran = await runAnalyzeIfDue({
        execute: async (sql, params) => {
          executed.push(sql.trim())
          if (params && params.length > 0) {
            h.db.prepare(sql).run(...(params as Array<string | number | null>))
          } else {
            h.db.exec(sql)
          }
        },
        getOptional: async <T,>(sql: string) => {
          const row = h.db.prepare(sql).get() as T | undefined
          return row ?? null
        },
      }, now)
      return {ran, executed}
    }
    return run
  }

  const recordedAt = (): number | null => {
    const row = h.db
      .prepare(`SELECT completed_at FROM client_schema_state WHERE key = '${ANALYZE_MARKER_KEY}'`)
      .get() as {completed_at: number} | undefined
    return row?.completed_at ?? null
  }

  it('runs ANALYZE and records the marker on first call', async () => {
    expect(recordedAt()).toBeNull()
    const run = buildRunner(() => 1_700_000_000_000)
    const {ran, executed} = await run()
    expect(ran).toBe(true)
    expect(executed.some(sql => sql === 'ANALYZE')).toBe(true)
    expect(recordedAt()).toBe(1_700_000_000_000)
  })

  it('is a no-op within the refresh interval', async () => {
    await buildRunner(() => 1_700_000_000_000)()
    // One ms before the interval elapses — still fresh, must skip.
    const run = buildRunner(() => 1_700_000_000_000 + ANALYZE_REFRESH_INTERVAL_MS - 1)
    const {ran, executed} = await run()
    expect(ran).toBe(false)
    expect(executed).toEqual([])
    expect(recordedAt()).toBe(1_700_000_000_000)
  })

  it('refreshes once the interval has elapsed', async () => {
    await buildRunner(() => 1_700_000_000_000)()
    const refreshAt = 1_700_000_000_000 + ANALYZE_REFRESH_INTERVAL_MS + 1
    const run = buildRunner(() => refreshAt)
    const {ran, executed} = await run()
    expect(ran).toBe(true)
    expect(executed.some(sql => sql === 'ANALYZE')).toBe(true)
    expect(recordedAt()).toBe(refreshAt)
  })
})
