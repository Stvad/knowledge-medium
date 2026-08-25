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
 *   - row_events audit/history triggers fire for both local and sync-applied
 *     writes; source COALESCEs NULL → 'sync', 'user' passes through; tx_id is
 *     NULL on sync apply; soft-delete UPDATE emits kind='soft-delete'
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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BLOCK_STORAGE_COLUMNS,
  CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL,
  CREATE_BLOCKS_SYNCED_TABLE_SQL,
  CREATE_BLOCKS_TABLE_SQL,
  CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL,
} from '@/data/blockSchema'
import {
  CREATE_WORKSPACE_MEMBERS_INDEX_SQL,
  CREATE_WORKSPACE_MEMBERS_TABLE_SQL,
} from '@/data/workspaceSchema'
import {
  CREATE_BLOCK_REFERENCES_TABLE_SQL,
  CREATE_BLOCK_REFERENCES_TARGET_INDEX_SQL,
  CREATE_BLOCK_REFERENCES_WS_ALIAS_INDEX_SQL,
} from '@/plugins/references/localSchema'
import {
  ALIAS_BACKFILL_MARKER_KEY,
  BACKFILL_BLOCK_ALIASES_SQL,
  BACKFILL_BLOCKS_FTS_SQL,
  BLOCKS_FTS_BACKFILL_MARKER_KEY,
  CLIENT_SCHEMA_STATEMENTS,
  CREATE_CLIENT_SCHEMA_STATE_TABLE_SQL,
  backfillBlockAliasesIfEmpty,
  backfillBlocksFtsIfEmpty,
  ensureBlockUserUpdatedAtColumn,
  ensureUndoGroupIdColumns,
  ANALYZE_OPTIMIZE_SQL,
  runAnalyzeIfStale,
  runAnalyzeNow,
} from './clientSchema'

interface TestDb {
  db: DatabaseSync
  setTxContext: (ctx: { txId?: string | null; txSeq?: number | null; userId?: string | null; scope?: string | null; source?: string | null; groupId?: string | null }) => void
  clearTxContext: () => void
  insertBlock: (overrides?: Partial<BlockInsert>) => void
  insertWorkspaceMember: (overrides?: Partial<WorkspaceMemberInsert>) => void
  updateBlock: (id: string, set: Record<string, unknown>) => void
  deleteBlock: (id: string) => void
  psCrud: () => Array<{ id: number; data: string; tx_id: number | null }>
  rowEvents: () => Array<RowEventRow>
  rowEventCount: () => number
}

interface RowEventRow {
  id: number
  tx_id: string | null
  group_id: string | null
  block_id: string
  kind: string
  before_json: string | null
  after_json: string | null
  source: string
  created_at: number
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
  user_updated_at: number | null
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
  user_updated_at: 1700000000000,
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
  // Layout B staging table — the blocks_synced change-capture triggers in
  // CLIENT_SCHEMA_STATEMENTS attach to it, so it must exist first.
  db.exec(CREATE_BLOCKS_SYNCED_TABLE_SQL)
  db.exec(CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL)
  db.exec(CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL)

  // workspace_members is a sibling table; created here so tests can
  // seed membership rows. Production builds the same schema from
  // src/data/workspaceSchema.ts.
  db.exec(CREATE_WORKSPACE_MEMBERS_TABLE_SQL)
  db.exec(CREATE_WORKSPACE_MEMBERS_INDEX_SQL)

  // block_references is contributed by the references plugin's local schema,
  // not CLIENT_SCHEMA_STATEMENTS — but it IS part of the real client schema,
  // and one of ANALYZE_ARMING_PROBES targets it. Without it here the probe
  // would take its missing-table branch on every ANALYZE test, which is the
  // fallback path rather than the one production runs.
  db.exec(CREATE_BLOCK_REFERENCES_TABLE_SQL)
  db.exec(CREATE_BLOCK_REFERENCES_TARGET_INDEX_SQL)
  db.exec(CREATE_BLOCK_REFERENCES_WS_ALIAS_INDEX_SQL)

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
    setTxContext: ({txId = null, txSeq = null, userId = null, scope = null, source = null, groupId = null}) => {
      db.exec(
        `UPDATE tx_context SET tx_id = ${sqlLit(txId)}, tx_seq = ${txSeq === null ? 'NULL' : String(txSeq)}, user_id = ${sqlLit(userId)}, scope = ${sqlLit(scope)}, source = ${sqlLit(source)}, group_id = ${sqlLit(groupId)} WHERE id = 1`,
      )
    },
    clearTxContext: () => {
      db.exec('UPDATE tx_context SET tx_id = NULL, tx_seq = NULL, user_id = NULL, scope = NULL, source = NULL, group_id = NULL WHERE id = 1')
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
    psCrud: () => db.prepare('SELECT * FROM ps_crud ORDER BY id').all() as unknown as { id: number; data: string; tx_id: number | null }[],
    rowEvents: () => db.prepare('SELECT * FROM row_events ORDER BY id').all() as unknown as RowEventRow[],
    rowEventCount: () => (db.prepare('SELECT COUNT(*) AS n FROM row_events').get() as {n: number}).n,
  }
}

const sqlLit = (v: string | null) => (v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`)

let h: TestDb
beforeEach(() => { h = setupDb() })
afterEach(() => { h.db.close() })

describe('client schema bootstrap', () => {
  // The trigger *names* are exported as CLIENT_SCHEMA_TRIGGER_NAMES purely so
  // a test can re-list them; asserting "the DB has exactly that list" only
  // restates the constant. What the triggers actually *do* is covered by the
  // row_events / upload-routing behavior tests below, and the harness already
  // verifies the production trigger set installs (createTestDb.test.ts).
  it('seeds tx_context with one row that starts NULL across all six tx fields', () => {
    const ctx = h.db.prepare('SELECT * FROM tx_context').get() as Record<string, unknown>
    expect(ctx).toEqual({id: 1, tx_id: null, tx_seq: null, user_id: null, scope: null, source: null, group_id: null})
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

// The body a client bootstrapped before D-3.1 (commit b3b1bc52) still carries:
// workspace_id is CHANGE-GATED, so a content-only edit drops it from the upload
// envelope. That strands e2ee PATCH uploads — the encrypt-on-upload hook routes
// on payload.workspace_id, so without it the plaintext content reaches the
// server and the e2ee ciphertext CHECK rejects it (SQLSTATE 23514). Faithful to
// the trigger pulled off a live affected client. `CREATE TRIGGER IF NOT EXISTS`
// would never replace this on upgrade — the schema applier must drop+recreate.
const STALE_BLOCKS_UPLOAD_UPDATE_TRIGGER_SQL = `
  CREATE TRIGGER blocks_upload_update
  AFTER UPDATE ON blocks
  WHEN (SELECT source FROM tx_context WHERE id = 1) IS NOT NULL
  BEGIN
    INSERT INTO ps_crud (tx_id, data) VALUES (
      (SELECT tx_seq FROM tx_context WHERE id = 1),
      json_object(
        'op', 'PATCH',
        'type', 'blocks',
        'id', NEW.id,
        'data', json_remove(
          json_set(
            '{}',
            CASE WHEN OLD.workspace_id IS NOT NEW.workspace_id THEN '$.workspace_id' ELSE '$.__noop' END, NEW.workspace_id,
            CASE WHEN OLD.content IS NOT NEW.content THEN '$.content' ELSE '$.__noop' END, NEW.content
          ),
          '$.__noop'
        )
      )
    );
  END
`

describe('client schema upgrade — trigger bodies re-apply on a stale DB', () => {
  it('replaces a stale blocks_upload_update so content-only PATCHes still carry workspace_id', () => {
    // Regress the freshly-bootstrapped DB to a pre-D-3.1 client: clobber the
    // current trigger with the stale (workspace_id change-gated) body.
    h.db.exec('DROP TRIGGER blocks_upload_update')
    h.db.exec(STALE_BLOCKS_UPLOAD_UPDATE_TRIGGER_SQL)

    // App startup after the fix shipped re-runs the schema set. With plain
    // CREATE TRIGGER IF NOT EXISTS this is a no-op (stale body persists); the
    // drop+recreate applier re-installs the current body.
    for (const stmt of CLIENT_SCHEMA_STATEMENTS) h.db.exec(stmt)

    h.insertBlock({id: 'b1', content: 'old'}) // source NULL → no upload noise
    h.setTxContext({txId: 'tx-1', txSeq: 1, userId: 'user-1', scope: 'block-default', source: 'user'})
    h.updateBlock('b1', {content: 'new'}) // content-only edit; workspace_id unchanged
    h.clearTxContext()

    const payload = JSON.parse(h.psCrud()[0].data)
    expect(payload).toMatchObject({op: 'PATCH', id: 'b1'})
    expect(payload.data.workspace_id).toBe('ws1')
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
    // tx_context stays at its post-clear state: source IS NULL — the shape an
    // observer materialize of an incoming change leaves it in.
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

describe('row_events trigger — group_id projection (issue #306)', () => {
  it('stamps group_id when a grouped local tx is open', () => {
    h.setTxContext({txId: 'tx-A', userId: 'user-1', scope: 'block-default', source: 'user', groupId: 'grp-1'})
    h.insertBlock({id: 'b1'})
    h.clearTxContext()
    expect(h.rowEvents()[0]).toMatchObject({tx_id: 'tx-A', group_id: 'grp-1'})
  })

  it('stamps NULL group_id for ungrouped local txs', () => {
    h.setTxContext({txId: 'tx-B', userId: 'user-1', scope: 'block-default', source: 'user'})
    h.insertBlock({id: 'b2'})
    h.clearTxContext()
    expect(h.rowEvents()[0]).toMatchObject({tx_id: 'tx-B', group_id: null})
  })

  it('stamps NULL group_id for sync-applied writes (source NULL)', () => {
    h.insertBlock({id: 'b3'})
    expect(h.rowEvents()[0]).toMatchObject({source: 'sync', tx_id: null, group_id: null})
  })

  it('belt-and-suspenders: stale group_id with NULL source still emits group_id=NULL', () => {
    h.db.exec("UPDATE tx_context SET group_id = 'stale-grp', source = NULL WHERE id = 1")
    h.insertBlock({id: 'b4'})
    expect(h.rowEvents()[0]).toMatchObject({source: 'sync', group_id: null})
  })

  it('projects group_id on UPDATE and DELETE row events too', () => {
    h.insertBlock({id: 'b5'}) // sync seed
    h.setTxContext({txId: 'tx-C', userId: 'user-1', scope: 'block-default', source: 'user', groupId: 'grp-2'})
    h.updateBlock('b5', {content: 'edited'})
    h.deleteBlock('b5')
    h.clearTxContext()
    const [, update, del] = h.rowEvents()
    expect(update).toMatchObject({kind: 'update', group_id: 'grp-2'})
    expect(del).toMatchObject({kind: 'delete', group_id: 'grp-2'})
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

  it('forwards changed columns plus the always-present workspace_id in PATCH payloads', () => {
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
    // workspace_id and base_updated_at are always emitted (even on a
    // content-only edit) — the first so the encrypt-on-upload hook can look up
    // the WK + build AAD, the second so the server can tell a drifted merge
    // from a clean one (#381). The rest are change-gated.
    expect(payload.data).toEqual({
      workspace_id: 'ws1',
      base_updated_at: 1700000000000,
      content: 'new',
      updated_at: 1700000999000,
      updated_by: 'user-2',
    })
  })

  it('keeps explicit nulls in changed UPDATE PATCH payloads (alongside workspace_id)', () => {
    h.insertBlock({id: 'b1', parent_id: 'old-parent'})
    h.setTxContext({txId: 'tx-1', txSeq: 5151, userId: 'user-1', scope: 'block-default', source: 'user'})
    h.updateBlock('b1', {parent_id: null})
    h.clearTxContext()

    const payload = JSON.parse(h.psCrud()[0].data)
    expect(payload.data).toEqual({
      workspace_id: 'ws1',
      base_updated_at: 1700000000000,
      parent_id: null,
    })
  })

  it('stamps base_updated_at with the row version the edit started from, not the one it wrote (#381)', () => {
    // The base is the server-confirmed version this edit was made AGAINST, so
    // the server can ask "did the row move under them?" and force the echo to
    // materialize when it did. Emitting NEW.updated_at instead would make every
    // patch look clean and leave the bug exactly where it was.
    h.insertBlock({id: 'b1', content: 'old', updated_at: 1700000000000})
    h.setTxContext({txId: 'tx-1', txSeq: 1, userId: 'user-1', scope: 'block-default', source: 'user'})
    h.updateBlock('b1', {content: 'new', updated_at: 1700000000500})
    h.clearTxContext()

    const {data} = JSON.parse(h.psCrud()[0].data)
    expect(data.base_updated_at).toBe(1700000000000)
    expect(data.updated_at).toBe(1700000000500)
  })

  it('re-bases each edit in a burst on the previous local version', () => {
    // Two edits before any upload: the second patch's base is the FIRST edit's
    // stamp — a version the server has never seen. That is why the upload
    // compactor keeps the EARLIEST base when it coalesces a burst into one wire
    // PATCH (see mergePatchPayloads in services/powersync.ts); taking this one
    // would describe a server state that never existed.
    h.insertBlock({id: 'b1', content: 'v0', updated_at: 1700000000000})
    h.setTxContext({txId: 'tx-1', txSeq: 1, userId: 'user-1', scope: 'block-default', source: 'user'})
    h.updateBlock('b1', {content: 'v1', updated_at: 1700000000100})
    h.updateBlock('b1', {content: 'v2', updated_at: 1700000000200})
    h.clearTxContext()

    const bases = h.psCrud().map(row => JSON.parse(row.data).data.base_updated_at)
    expect(bases).toEqual([1700000000000, 1700000000100])
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

// Real-SQLite adapter shaped like PowerSync's `execute` (rows under
// `rows._array`), recording every statement so a test can assert what ran.
const buildRecordingDb = ({
  failOn,
}: {failOn?: RegExp} = {}) => {
  const executed: string[] = []
  const db = {
    execute: async (sql: string, params?: unknown[]) => {
      executed.push(sql.trim())
      if (failOn?.test(sql)) throw new Error(`[test] forced failure on: ${sql.trim()}`)
      const stmt = h.db.prepare(sql)
      const bind = params as Array<string | number | null> | undefined
      // `.all()` rather than `.run()` throughout: PRAGMA statements RETURN rows,
      // and reading them is how the optimize path reports what it did.
      const rows = bind && bind.length > 0 ? stmt.all(...bind) : stmt.all()
      return {rows: {_array: rows}}
    },
    getOptional: async <T,>(sql: string, params?: unknown[]) => {
      const stmt = h.db.prepare(sql)
      const bind = params as Array<string | number | null> | undefined
      const row = (bind && bind.length > 0 ? stmt.get(...bind) : stmt.get()) as T | undefined
      return row ?? null
    },
  }
  return {db, executed, ranAnalyze: () => executed.some(s => /^ANALYZE\b/.test(s))}
}

const statRows = (db: DatabaseSync, tbl: string): Record<string, string> => {
  const present = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_stat1'`,
  ).get()
  if (!present) return {}
  const rows = db.prepare(
    `SELECT COALESCE(idx,'') AS idx, stat FROM sqlite_stat1 WHERE tbl = ?`,
  ).all(tbl) as Array<{idx: string; stat: string}>
  return Object.fromEntries(rows.map(r => [r.idx, r.stat]))
}

// `PRAGMA optimize` replaced a hand-rolled two-axis staleness trigger (`blocks`
// row-count drift + a fingerprint of the index set / which indexes have stats,
// recorded as a marker row). SQLite already tracks both, and knows things we
// could not see from outside — see the module comment on ANALYZE_ARMING_PROBES
// and `docs/pragma-optimize-spike/` for the measurements.
//
// What these pin are the two non-obvious parts: that the arming probes are
// required, and that the recorded stats are exact rather than sampled.
describe('runAnalyzeIfStale', () => {
  const seedBlocks = (n: number) => {
    for (let i = 0; i < n; i++) h.insertBlock({id: `blk-${i}`, order_key: `a${i}`})
  }

  it('populates stats for a newly created index', async () => {
    // The regression this whole mechanism exists for. A fresh index has no
    // sqlite_stat1 row, so SQLite assumes ~10 rows for an equality seek on its
    // leading column — and every hot index here leads with workspace_id, whose
    // real selectivity is ~1. That inverts join order: measured 6297ms -> 3ms.
    seedBlocks(64)
    await runAnalyzeIfStale(buildRecordingDb().db)
    h.db.exec('CREATE INDEX idx_test_new ON blocks (workspace_id, updated_at)')
    expect(statRows(h.db, 'blocks')['idx_test_new']).toBeUndefined()

    await runAnalyzeIfStale(buildRecordingDb().db)
    expect(statRows(h.db, 'blocks')['idx_test_new']).toBeDefined()
  })

  it('leaves a settled database alone', async () => {
    seedBlocks(64)
    await runAnalyzeIfStale(buildRecordingDb().db)
    const settled = statRows(h.db, 'blocks')

    const result = await runAnalyzeIfStale(buildRecordingDb().db)
    // Nothing stale => the dry run proposes nothing and no stats move. This is
    // the every-boot case: it has to stay free.
    expect(result.proposed).toEqual([])
    expect(statRows(h.db, 'blocks')).toEqual(settled)
  })

  it('reports the tables it decided to re-analyze', async () => {
    seedBlocks(64)
    await runAnalyzeIfStale(buildRecordingDb().db)
    h.db.exec('CREATE INDEX idx_test_reported ON blocks (workspace_id, updated_at)')

    const result = await runAnalyzeIfStale(buildRecordingDb().db)
    expect(result.proposed).toEqual([expect.stringContaining('"blocks"')])
  })

  it('reports null rather than "nothing happened" when the db surface drops rows', async () => {
    // Bootstrap shims resolve `execute` to undefined. The optimize still runs;
    // we just cannot say what it did, and must not claim it did nothing.
    seedBlocks(64)
    const db = {
      execute: async (sql: string) => { h.db.exec(sql) },
      getOptional: async () => null,
    }
    const result = await runAnalyzeIfStale(db)
    expect(result.proposed).toBeNull()
    // ...and it really did analyze, despite reporting nothing.
    expect(statRows(h.db, 'blocks')['idx_blocks_workspace_active']).toBeDefined()
  })

  it('still analyzes when a table an arming probe names is absent', async () => {
    // A probe is best-effort: one missing table must not cost the session its
    // stats entirely. That failure mode — "no stats at all this session" — is
    // strictly worse than one unarmed table, and this code has hit it before.
    seedBlocks(64)
    h.db.exec('DROP TABLE block_references')
    const result = await runAnalyzeIfStale(buildRecordingDb().db)
    expect(result.proposed).toEqual(expect.arrayContaining([expect.stringContaining('"blocks"')]))
    expect(statRows(h.db, 'blocks')['idx_blocks_workspace_active']).toBeDefined()
  })
})

// REVERT-TEST for ANALYZE_ARMING_PROBES. Delete the arming loop from
// `runAnalyzeIfStale` and this fails; nothing else in the suite does, because
// the new-index axis fires with or without arming.
//
// Needs a file-backed DB and a genuine reconnect: SQLite caches sqlite_stat1 in
// memory at schema load, so damaging the table in-connection is invisible to the
// staleness heuristic (and `ANALYZE sqlite_master` does not reload it either).
// A reopen is what production does anyway — this is the next-boot path.
describe('runAnalyzeIfStale — arming (stale-stats axis)', () => {
  let dir: string
  let db: DatabaseSync
  const open = () => new DatabaseSync(join(dir, 'arming.db'))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'analyze-arming-'))
    db = open()
    db.exec(CREATE_BLOCKS_TABLE_SQL)
    db.exec(CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL)
    db.exec(CREATE_CLIENT_SCHEMA_STATE_TABLE_SQL)
    const cols = BLOCK_STORAGE_COLUMNS.map(c => c.name)
    const ins = db.prepare(
      `INSERT INTO blocks (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    )
    // One transaction, not 2500 auto-commit ones: this db is file-backed, so an
    // unwrapped insert costs its own fsync and the loop then dominates a hook
    // that runs per test — enough to cross vitest's hookTimeout under gate load.
    // Batching is a cost change only; ANALYZE records the same stats either way.
    //
    // 2500 and not a round 500: it has to exceed SQLite's OWN
    // SQLITE_DEFAULT_OPTIMIZE_LIMIT of 2000, which `PRAGMA optimize`'s default
    // mask applies regardless of `analysis_limit`. A 500-row fixture sits under
    // that cap and reads as exact no matter which mask the optimize uses.
    db.exec('BEGIN')
    for (let i = 0; i < 2500; i++) {
      ins.run(...cols.map(c => {
        if (c === 'id') return `b-${i}`
        // One workspace for all 2500, deliberately: it reproduces the real
        // shape — one leading-column value covering the table — that a sampled
        // ANALYZE records wrongly ('records the exact rows-per-workspace').
        if (c === 'workspace_id') return 'ws1'
        if (c === 'order_key') return `a${i}`
        if (c === 'created_at' || c === 'updated_at') return 1
        if (c === 'created_by' || c === 'updated_by') return 'u1'
        if (c === 'deleted') return 0
        if (c === 'content') return 'x'
        if (c === 'properties_json') return '{}'
        if (c === 'references_json') return '[]'
        return null
      }) as Array<string | number | null>)
    }
    db.exec('COMMIT')
    // Settle, then corrupt to the degenerate legacy shape.
    db.exec('ANALYZE')
    db.exec(`UPDATE sqlite_stat1 SET stat = '0 0' WHERE tbl = 'blocks'`)
    db.close()
    db = open()
  })
  afterEach(() => {
    db.close()
    rmSync(dir, {recursive: true, force: true})
  })

  const adapter = () => ({
    execute: async (sql: string) => ({rows: {_array: db.prepare(sql).all()}}),
    getOptional: async <T,>(sql: string) => (db.prepare(sql).get() ?? null) as T | null,
  })

  it('repairs degenerate "0 0" stats', async () => {
    expect(statRows(db, 'blocks')['idx_blocks_workspace_active']).toBe('0 0')
    await runAnalyzeIfStale(adapter())
    expect(statRows(db, 'blocks')['idx_blocks_workspace_active']).not.toBe('0 0')
  })

  it('records the exact rows-per-workspace, not a sampled approximation', async () => {
    // REVERT-TEST for both halves of the unbounded pass, and it fails on either.
    // Reinstate `PRAGMA analysis_limit=400` and the second field comes back 401;
    // drop the `0x02` mask from ANALYZE_OPTIMIZE_SQL and it comes back 2001,
    // because the default mask's `0x10` bit applies SQLite's own 2000-row limit
    // whatever `analysis_limit` says. Either way the planner is told
    // "workspace_id selects a few hundred rows" about a column that has one or
    // two values, and every workspace-scoped join inverts. Asserts the stat
    // rather than a timing, because at this scale the passes cost the same.
    //
    // Mutation-subsumed by 'clears a standing sample limit' below — every
    // mutation that kills this kills that one too. Kept anyway: the `rowCount`
    // assertion guards the FIXTURE, not the code. Both caps (400 and 2000) are
    // invisible below 2500 rows, so a shrunk fixture would leave the mask pin
    // reading green against nothing, and this is the line that fails first.
    await runAnalyzeIfStale(adapter())
    const [rowCount, avgPerWorkspace] = statRows(db, 'blocks')['idx_blocks_workspace_active']
      .split(' ').map(Number)
    expect(rowCount).toBe(2500)
    expect(avgPerWorkspace).toBe(2500)
  })

  it('clears a standing sample limit before analyzing', async () => {
    // `analysis_limit` is CONNECTION state, so an ANALYZE inherits whatever was
    // set last — the agent bridge runs arbitrary SQL on this same connection.
    // Everything the pass records would otherwise be sampled.
    // (NOT another tab: an OPFS VFS gives each tab its own dedicated worker and
    // connection, so tabs cannot see each other's PRAGMA state.)
    db.exec('PRAGMA analysis_limit=400')

    await runAnalyzeIfStale(adapter())
    const [, avgPerWorkspace] = statRows(db, 'blocks')['idx_blocks_workspace_active']
      .split(' ').map(Number)
    expect(avgPerWorkspace).toBe(2500)
  })

  it('the manual command is unbounded even on a connection left sampling', async () => {
    // The escape hatch exists for stats that are present and schema-current but
    // wrong. A limit left standing on the connection would hand the user who
    // reached for the button the same approximation they are trying to escape.
    db.exec('PRAGMA analysis_limit=400')

    await runAnalyzeNow(adapter())
    const [, avgPerWorkspace] = statRows(db, 'blocks')['idx_blocks_workspace_active']
      .split(' ').map(Number)
    expect(avgPerWorkspace).toBe(2500)
  })

  it('does not repair them without the probes — the arming is load-bearing', async () => {
    // Same DB, same PRAGMAs, only the arming omitted. `PRAGMA optimize` skips a
    // table this connection never planned a query against, so it walks away
    // leaving the stats that invert join order in place.
    db.exec(ANALYZE_OPTIMIZE_SQL)
    expect(statRows(db, 'blocks')['idx_blocks_workspace_active']).toBe('0 0')
  })
})

describe('ANALYZE serialization', () => {
  // Four schedulers point at these two functions and each statement is
  // separately awaited, so overlapping callers interleave. Two concurrent
  // passes are two multi-second parks of this tab's SQLite connection to reach
  // one settled sqlite_stat1.
  const taggedDb = (tag: string, log: string[]) => ({
    execute: async (sql: string) => {
      log.push(`${tag}:${sql.trim()}`)
      return {rows: {_array: h.db.prepare(sql).all()}}
    },
    getOptional: async <T,>(sql: string) => (h.db.prepare(sql).get() ?? null) as T | null,
  })

  it('never interleaves the automatic and manual sequences', async () => {
    for (let i = 0; i < 8; i++) h.insertBlock({id: `blk-${i}`, order_key: `a${i}`})
    const log: string[] = []
    await Promise.all([
      runAnalyzeIfStale(taggedDb('auto', log)),
      runAnalyzeNow(taggedDb('manual', log)),
    ])

    // Whoever went first must have finished before the other's first statement.
    const tags = log.map(entry => entry.split(':')[0])
    const switches = tags.filter((tag, i) => i > 0 && tag !== tags[i - 1]).length
    expect(switches).toBe(1)
  })

  it('a failed pass does not wedge the queue', async () => {
    // The chain must not stay rejected — one throwing caller would otherwise
    // take every later ANALYZE with it, for the life of the tab.
    // Derive the pattern from ANALYZE_OPTIMIZE_SQL, never a literal: a hardcoded
    // one stops matching when the mask changes, and the injection then fails
    // nothing while the test still passes.
    const {db: failing} = buildRecordingDb({
      failOn: new RegExp(`^${ANALYZE_OPTIMIZE_SQL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
    })
    await expect(runAnalyzeIfStale(failing)).rejects.toThrow('forced failure')

    h.insertBlock({id: 'after-failure'})
    const {db, ranAnalyze} = buildRecordingDb()
    await runAnalyzeNow(db)
    expect(ranAnalyze()).toBe(true)
  })
})

// The probes' own properties — read-only, param-free, and each one planning to
// an index SEARCH — are checked over the RESOLVED set (core + every installed
// contribution) in `src/data/localSchema.test.ts`. Asserting them over the core
// constant alone would leave a contributed probe unchecked, which is the half
// that has no author looking at this file.

describe('runAnalyzeNow', () => {
  it('runs ANALYZE unconditionally and reports the live count', async () => {
    // No staleness gate: a single block still analyzes. The user asked.
    h.insertBlock({id: 'only-block'})
    const {db, ranAnalyze} = buildRecordingDb()
    const {count} = await runAnalyzeNow(db)
    expect(count).toBe(1)
    expect(ranAnalyze()).toBe(true)
  })


})

// The block_types side-index backs byType / typedBlocks — among the most
// subscribed queries in the app — yet (unlike block_aliases / blocks_fts)
// its three maintenance triggers had no dedicated coverage. A silent
// regression here corrupts every typed-block result with nothing catching
// it.
describe('block_types side-index triggers', () => {
  const types = (): Array<{block_id: string; workspace_id: string; type: string}> =>
    h.db
      .prepare('SELECT block_id, workspace_id, type FROM block_types ORDER BY block_id, type')
      .all() as unknown as Array<{block_id: string; workspace_id: string; type: string}>

  const withTypes = (...t: unknown[]) => JSON.stringify({types: t})

  it('insert: indexes every text entry in properties_json.$.types', () => {
    h.insertBlock({id: 'b1', workspace_id: 'ws1', properties_json: withTypes('todo', 'project')})
    expect(types()).toEqual([
      {block_id: 'b1', workspace_id: 'ws1', type: 'project'},
      {block_id: 'b1', workspace_id: 'ws1', type: 'todo'},
    ])
  })

  it('insert: ignores non-text entries and skips soft-deleted rows', () => {
    h.insertBlock({id: 'b1', properties_json: withTypes('todo', 42, null)})
    expect(types().map(t => t.type)).toEqual(['todo'])

    h.insertBlock({id: 'b2', deleted: 1, properties_json: withTypes('todo')})
    expect(types().filter(t => t.block_id === 'b2')).toEqual([])
  })

  it('update: re-derives the whole type set when properties_json changes', () => {
    h.insertBlock({id: 'b1', properties_json: withTypes('todo')})
    h.updateBlock('b1', {properties_json: withTypes('project', 'area')})
    expect(types().map(t => t.type)).toEqual(['area', 'project'])
  })

  it('update: a soft-delete removes the type rows', () => {
    h.insertBlock({id: 'b1', properties_json: withTypes('todo')})
    expect(types()).toHaveLength(1)
    h.updateBlock('b1', {deleted: 1})
    expect(types()).toEqual([])
  })

  it('update: a workspace move re-homes the type rows', () => {
    h.insertBlock({id: 'b1', workspace_id: 'ws1', properties_json: withTypes('todo')})
    h.updateBlock('b1', {workspace_id: 'ws2'})
    expect(types()).toEqual([{block_id: 'b1', workspace_id: 'ws2', type: 'todo'}])
  })

  it('delete: removes the type rows', () => {
    h.insertBlock({id: 'b1', properties_json: withTypes('todo', 'project')})
    expect(types()).toHaveLength(2)
    h.deleteBlock('b1')
    expect(types()).toEqual([])
  })
})

// Table-aware db stand-in: PRAGMA table_info(<t>) returns the columns declared
// for <t>, and every executed statement is recorded in order.
const fakeMigrationDb = (columnsByTable: Record<string, string[]>) => {
  const executed: string[] = []
  return {
    executed,
    execute: async (sql: string) => { executed.push(sql) },
    getAll: async <T,>(sql: string): Promise<T[]> => {
      const table = sql.match(/table_info\((\w+)\)/)?.[1] ?? ''
      return (columnsByTable[table] ?? []).map((name) => ({name})) as unknown as T[]
    },
  }
}

describe('ensureBlockUserUpdatedAtColumn — local migration', () => {
  it('adds the column to BOTH tables and backfills blocks with the audit trigger suspended', async () => {
    const db = fakeMigrationDb({
      blocks: ['id', 'updated_at'],
      blocks_synced: ['id', 'updated_at'],
    })
    await ensureBlockUserUpdatedAtColumn(db)
    const e = db.executed

    expect(e.filter(s => s.includes('ADD COLUMN user_updated_at'))).toHaveLength(2)
    expect(e.some(s => s.includes('ALTER TABLE blocks ADD COLUMN user_updated_at'))).toBe(true)
    expect(e.some(s => s.includes('ALTER TABLE blocks_synced ADD COLUMN user_updated_at'))).toBe(true)

    // The backfill is bracketed: drop the unconditional row_event trigger, run
    // the UPDATE trigger-free, then recreate it — so it never writes one
    // row_events row per block (the burst this fix exists to prevent).
    const dropAt = e.findIndex(s => /DROP TRIGGER IF EXISTS blocks_row_event_update/.test(s))
    const updateAt = e.findIndex(s => /UPDATE blocks SET user_updated_at = updated_at/.test(s))
    const recreateAt = e.findIndex(s => /CREATE TRIGGER IF NOT EXISTS\s+blocks_row_event_update/.test(s))
    expect(dropAt).toBeGreaterThanOrEqual(0)
    expect(dropAt).toBeLessThan(updateAt)     // dropped before the backfill UPDATE
    expect(updateAt).toBeLessThan(recreateAt) // recreated after it
  })

  it('does NOT backfill or touch the trigger when the column already exists (fresh install / steady state)', async () => {
    const db = fakeMigrationDb({
      blocks: ['id', 'updated_at', 'user_updated_at'],
      blocks_synced: ['id', 'updated_at', 'user_updated_at'],
    })
    await ensureBlockUserUpdatedAtColumn(db)
    expect(db.executed.some(s => s.includes('ADD COLUMN'))).toBe(false)
    expect(db.executed.some(s => /UPDATE blocks SET user_updated_at/.test(s))).toBe(false)
    expect(db.executed.some(s => /blocks_row_event_update/.test(s))).toBe(false)
  })

  it('adds only blocks_synced (no backfill) when only it is missing the column', async () => {
    const db = fakeMigrationDb({
      blocks: ['id', 'updated_at', 'user_updated_at'],
      blocks_synced: ['id', 'updated_at'],
    })
    await ensureBlockUserUpdatedAtColumn(db)
    const alters = db.executed.filter(s => s.includes('ADD COLUMN'))
    expect(alters).toHaveLength(1)
    expect(alters[0]).toContain('ALTER TABLE blocks_synced')
    // blocks already had the column → no backfill, trigger untouched.
    expect(db.executed.some(s => /UPDATE blocks SET user_updated_at/.test(s))).toBe(false)
    expect(db.executed.some(s => /blocks_row_event_update/.test(s))).toBe(false)
  })
})

describe('ensureUndoGroupIdColumns — local migration (issue #306)', () => {
  it('adds group_id to both tx_context and row_events when missing', async () => {
    const db = fakeMigrationDb({
      tx_context: ['id', 'tx_id', 'tx_seq', 'user_id', 'scope', 'source'],
      row_events: ['id', 'tx_id', 'block_id', 'kind', 'before_json', 'after_json', 'source', 'created_at'],
    })
    await ensureUndoGroupIdColumns(db)
    const alters = db.executed.filter(s => s.includes('ADD COLUMN group_id'))
    expect(alters).toHaveLength(2)
    expect(alters.some(s => s.includes('ALTER TABLE tx_context'))).toBe(true)
    expect(alters.some(s => s.includes('ALTER TABLE row_events'))).toBe(true)
  })

  it('no-ops when the column already exists (fresh install / steady state)', async () => {
    const db = fakeMigrationDb({
      tx_context: ['id', 'tx_id', 'tx_seq', 'user_id', 'scope', 'source', 'group_id'],
      row_events: ['id', 'tx_id', 'block_id', 'kind', 'before_json', 'after_json', 'source', 'created_at', 'group_id'],
    })
    await ensureUndoGroupIdColumns(db)
    expect(db.executed.some(s => s.includes('ADD COLUMN'))).toBe(false)
  })

  it('skips tables that do not exist yet (fresh DB — CREATE TABLE carries the column)', async () => {
    const db = fakeMigrationDb({})
    await ensureUndoGroupIdColumns(db)
    expect(db.executed.some(s => s.includes('ADD COLUMN'))).toBe(false)
  })

  it('upgrades a pre-existing DB in place without losing row_events history (invariant 11)', async () => {
    // A device bootstrapped BEFORE the group_id column shipped: tx_context /
    // row_events exist with the old column set and carry history. Frozen
    // historical DDL — do not sync with the live constants.
    const old = new DatabaseSync(':memory:')
    old.exec(`
      CREATE TABLE tx_context (
        id      INTEGER PRIMARY KEY CHECK (id = 1),
        tx_id   TEXT,
        tx_seq  INTEGER,
        user_id TEXT,
        scope   TEXT,
        source  TEXT
      )
    `)
    old.exec('INSERT INTO tx_context (id) VALUES (1)')
    old.exec(`
      CREATE TABLE row_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        tx_id       TEXT,
        block_id    TEXT NOT NULL,
        kind        TEXT NOT NULL,
        before_json TEXT,
        after_json  TEXT,
        source      TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      )
    `)
    old.exec(`
      INSERT INTO row_events (tx_id, block_id, kind, before_json, after_json, source, created_at)
      VALUES ('tx-historic', 'b-old', 'update', '{"content":"a"}', '{"content":"b"}', 'user', 1700000000000)
    `)
    // The rest of the schema the statements/triggers need.
    old.exec(CREATE_BLOCKS_TABLE_SQL)
    old.exec(CREATE_BLOCKS_SYNCED_TABLE_SQL)
    old.exec('CREATE TABLE ps_crud (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL, tx_id INTEGER)')
    old.exec(CREATE_WORKSPACE_MEMBERS_TABLE_SQL)

    // App startup on the upgraded build: ensure columns FIRST (the
    // recreated triggers reference group_id), then the schema statements.
    const dbFacade = {
      execute: async (sql: string) => { old.exec(sql) },
      getAll: async <T,>(sql: string): Promise<T[]> => old.prepare(sql).all() as T[],
    }
    await ensureUndoGroupIdColumns(dbFacade)
    for (const stmt of CLIENT_SCHEMA_STATEMENTS) old.exec(stmt)

    // History intact; the historic row reads back with NULL group_id.
    const historic = old.prepare('SELECT * FROM row_events WHERE block_id = ?').get('b-old') as Record<string, unknown>
    expect(historic).toMatchObject({tx_id: 'tx-historic', kind: 'update', group_id: null})

    // New grouped writes stamp group_id through the recreated triggers.
    old.exec(`UPDATE tx_context SET tx_id = 'tx-new', tx_seq = 1, user_id = 'u1', scope = 'block-default', source = 'user', group_id = 'grp-new' WHERE id = 1`)
    old.exec(`INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json, references_json, created_at, updated_at, user_updated_at, created_by, updated_by, deleted)
              VALUES ('b-new', 'ws1', NULL, 'a0', '', '{}', '[]', 1, 1, 1, 'u1', 'u1', 0)`)
    const fresh = old.prepare('SELECT * FROM row_events WHERE block_id = ?').get('b-new') as Record<string, unknown>
    expect(fresh).toMatchObject({tx_id: 'tx-new', group_id: 'grp-new'})
    old.close()
  })
})

describe('blocks_synced_changes enqueue-collapse', () => {
  it('serves the collapse delete from an index, not a full table scan', () => {
    // The blocks_synced_changes_insert trigger runs
    // `DELETE ... WHERE id = NEW.id AND op = 'delete'` on EVERY staging insert.
    // Without an index that scans the whole pending queue, turning a bulk apply
    // (the queue fills within one PowerSync apply tx before the observer drains)
    // into O(n^2). Pin the load-bearing invariant — the lookup is index-backed —
    // so dropping the index, or the trigger predicate drifting off it, fails
    // loudly instead of silently regressing large syncs.
    const plan = (h.db
      .prepare("EXPLAIN QUERY PLAN DELETE FROM blocks_synced_changes WHERE id = ? AND op = 'delete'")
      .all('b1') as Array<{ detail: string }>)
      .map(r => r.detail)
      .join(' | ')
    expect(plan).toContain('USING INDEX')
    expect(plan).not.toContain('SCAN')
  })
})
