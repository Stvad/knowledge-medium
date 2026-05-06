// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  BLOCK_STORAGE_COLUMNS,
  CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL,
  CREATE_BLOCKS_TABLE_SQL,
  CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL,
} from '@/data/blockSchema'
import { CLIENT_SCHEMA_STATEMENTS } from '@/data/internals/clientSchema'
import {
  BACKFILL_BLOCK_REFERENCES_SQL,
  BLOCK_REFERENCES_BACKFILL_MARKER_KEY,
  BLOCK_REFERENCES_SOURCE_FIELD_MARKER_KEY,
  backlinksLocalSchema,
  backfillBlockReferencesIfEmpty,
  backfillBlockReferencesSourceFieldIfNeeded,
} from '../localSchema.ts'

interface TestDb {
  db: DatabaseSync
  insertBlock: (overrides?: Partial<BlockInsert>) => void
  updateBlock: (id: string, set: Record<string, unknown>) => void
  deleteBlock: (id: string) => void
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

interface ReferenceRow {
  source_id: string
  target_id: string
  workspace_id: string
  alias: string
  source_field: string
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

  db.exec(`
    CREATE TABLE ps_crud (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT NOT NULL,
      tx_id INTEGER
    )
  `)

  db.exec(CREATE_BLOCKS_TABLE_SQL)
  db.exec(CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL)
  db.exec(CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL)
  for (const stmt of CLIENT_SCHEMA_STATEMENTS) db.exec(stmt)
  for (const stmt of backlinksLocalSchema.statements ?? []) db.exec(stmt)

  const columnNames = BLOCK_STORAGE_COLUMNS.map(c => c.name)
  const insertStmt = db.prepare(
    `INSERT INTO blocks (${columnNames.join(',')}) VALUES (${columnNames.map(() => '?').join(',')})`,
  )

  return {
    db,
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
  }
}

const refRows = (db: DatabaseSync): ReferenceRow[] =>
  db
    .prepare('SELECT source_id, target_id, workspace_id, alias, source_field FROM block_references ORDER BY source_id, target_id, alias, source_field')
    .all() as unknown as ReferenceRow[]

const refsJson = (entries: Array<{ id: string; alias: string; sourceField?: string }>): string =>
  JSON.stringify(entries)

let h: TestDb
beforeEach(() => { h = setupDb() })
afterEach(() => { h.db.close() })

describe('backlinks local schema bootstrap', () => {
  it('creates backlink-owned triggers and indexes', () => {
    const triggers = (h.db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='blocks' ORDER BY name")
      .all() as Array<{name: string}>)
      .map(r => r.name)
    expect(triggers).toEqual(expect.arrayContaining([
      ...(backlinksLocalSchema.triggerNames ?? []),
    ]))

    const indexes = (h.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
      .all() as Array<{name: string}>)
      .map(r => r.name)
    expect(indexes).toEqual(expect.arrayContaining([
      'idx_blocks_workspace_with_references',
      'idx_block_references_target',
    ]))
  })

  it('schema statements are idempotent', () => {
    for (const stmt of backlinksLocalSchema.statements ?? []) {
      expect(() => h.db.exec(stmt)).not.toThrow()
    }
  })
})

describe('block_references trigger - INSERT', () => {
  it('extracts references_json into block_references on insert', () => {
    h.insertBlock({
      id: 'src',
      workspace_id: 'ws1',
      references_json: refsJson([
        {id: 'tgt-a', alias: 'A'},
        {id: 'tgt-b', alias: 'B'},
      ]),
    })
    expect(refRows(h.db)).toEqual([
      {source_id: 'src', target_id: 'tgt-a', workspace_id: 'ws1', alias: 'A', source_field: ''},
      {source_id: 'src', target_id: 'tgt-b', workspace_id: 'ws1', alias: 'B', source_field: ''},
    ])
  })

  it('inserts no rows for blocks without references', () => {
    h.insertBlock({id: 'src', references_json: '[]'})
    expect(refRows(h.db)).toEqual([])
  })

  it('inserts no rows for soft-deleted blocks', () => {
    h.insertBlock({
      id: 'src',
      references_json: refsJson([{id: 'tgt', alias: 'A'}]),
      deleted: 1,
    })
    expect(refRows(h.db)).toEqual([])
  })

  it('keeps both edges when one source links to one target via two aliases', () => {
    h.insertBlock({
      id: 'src',
      references_json: refsJson([
        {id: 'tgt', alias: 'Foo'},
        {id: 'tgt', alias: 'foo'},
      ]),
    })
    expect(refRows(h.db).map(r => r.alias)).toEqual(['Foo', 'foo'])
  })

  it('keeps property refs distinct by source field', () => {
    h.insertBlock({
      id: 'src',
      references_json: refsJson([
        {id: 'tgt', alias: 'tgt', sourceField: 'blocked-by'},
        {id: 'tgt', alias: 'tgt', sourceField: 'reviewer'},
      ]),
    })
    expect(refRows(h.db)).toEqual([
      {source_id: 'src', target_id: 'tgt', workspace_id: 'ws1', alias: 'tgt', source_field: 'blocked-by'},
      {source_id: 'src', target_id: 'tgt', workspace_id: 'ws1', alias: 'tgt', source_field: 'reviewer'},
    ])
  })

  it('skips defensively-malformed entries', () => {
    h.insertBlock({
      id: 'src',
      references_json: JSON.stringify([
        {id: 'tgt-a', alias: 'A'},
        {alias: 'no-id'},
        {id: 'tgt-b'},
        {id: 42, alias: 'numeric'},
        {id: 'tgt-c', alias: 'C'},
      ]),
    })
    expect(refRows(h.db).map(r => r.target_id)).toEqual(['tgt-a', 'tgt-c'])
  })
})

describe('block_references trigger - UPDATE', () => {
  it('replaces references when references_json changes', () => {
    h.insertBlock({
      id: 'src',
      references_json: refsJson([{id: 'old', alias: 'O'}]),
    })
    h.updateBlock('src', {
      references_json: refsJson([
        {id: 'new-1', alias: 'N1'},
        {id: 'new-2', alias: 'N2'},
      ]),
    })
    expect(refRows(h.db).map(r => r.target_id)).toEqual(['new-1', 'new-2'])
  })

  it('clears references on soft-delete', () => {
    h.insertBlock({
      id: 'src',
      references_json: refsJson([{id: 'tgt', alias: 'A'}]),
    })
    h.updateBlock('src', {deleted: 1})
    expect(refRows(h.db)).toEqual([])
  })

  it('repopulates references on tombstone restore', () => {
    h.insertBlock({
      id: 'src',
      references_json: refsJson([{id: 'tgt', alias: 'A'}]),
      deleted: 1,
    })
    expect(refRows(h.db)).toEqual([])
    h.updateBlock('src', {deleted: 0})
    expect(refRows(h.db).map(r => r.target_id)).toEqual(['tgt'])
  })

  it('does not fire on content-only edits', () => {
    h.insertBlock({
      id: 'src',
      references_json: refsJson([{id: 'tgt', alias: 'A'}]),
    })
    h.db
      .prepare('INSERT INTO block_references (source_id, target_id, workspace_id, alias) VALUES (?, ?, ?, ?)')
      .run('src', 'manual-tgt', 'ws1', 'manual-alias')
    h.updateBlock('src', {content: 'changed'})
    expect(refRows(h.db).map(r => r.target_id)).toContain('manual-tgt')
  })
})

describe('block_references trigger - DELETE', () => {
  it('clears references on hard-delete', () => {
    h.insertBlock({
      id: 'src',
      references_json: refsJson([{id: 'tgt', alias: 'A'}]),
    })
    h.deleteBlock('src')
    expect(refRows(h.db)).toEqual([])
  })
})

describe('block_references backfill', () => {
  it('populates the index from pre-existing blocks', () => {
    h.insertBlock({
      id: 'src1',
      workspace_id: 'ws1',
      references_json: refsJson([
        {id: 'tgt-a', alias: 'A'},
        {id: 'tgt-b', alias: 'B'},
      ]),
    })
    h.insertBlock({
      id: 'src2-deleted',
      workspace_id: 'ws1',
      references_json: refsJson([{id: 'tgt-c', alias: 'C'}]),
      deleted: 1,
    })
    h.insertBlock({
      id: 'src3',
      workspace_id: 'ws2',
      references_json: refsJson([{id: 'tgt-d', alias: 'D'}]),
    })
    h.db.exec('DELETE FROM block_references')

    h.db.exec(BACKFILL_BLOCK_REFERENCES_SQL)

    expect(refRows(h.db)).toEqual([
      {source_id: 'src1', target_id: 'tgt-a', workspace_id: 'ws1', alias: 'A', source_field: ''},
      {source_id: 'src1', target_id: 'tgt-b', workspace_id: 'ws1', alias: 'B', source_field: ''},
      {source_id: 'src3', target_id: 'tgt-d', workspace_id: 'ws2', alias: 'D', source_field: ''},
    ])
  })

  it('backfills source_field from references_json sourceField', () => {
    h.insertBlock({
      id: 'src',
      references_json: refsJson([
        {id: 'tgt', alias: 'tgt', sourceField: 'blocked-by'},
      ]),
    })
    h.db.exec('DELETE FROM block_references')

    h.db.exec(BACKFILL_BLOCK_REFERENCES_SQL)

    expect(refRows(h.db)).toEqual([
      {source_id: 'src', target_id: 'tgt', workspace_id: 'ws1', alias: 'tgt', source_field: 'blocked-by'},
    ])
  })

  it('is idempotent', () => {
    h.insertBlock({
      id: 'src',
      references_json: refsJson([{id: 'tgt', alias: 'A'}]),
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
      h.insertBlock({
        id: 'src',
        references_json: refsJson([{id: 'tgt', alias: 'A'}]),
      })
      h.db.exec('DELETE FROM block_references')
      await runBackfill()
      expect(refRows(h.db)).toHaveLength(0)
    })

    it('runs the backfill exactly once across multiple invocations', async () => {
      h.insertBlock({
        id: 'src',
        references_json: refsJson([{id: 'tgt', alias: 'A'}]),
      })
      h.db.exec('DELETE FROM block_references')

      await runBackfill()
      expect(refRows(h.db).map(r => r.target_id)).toEqual(['tgt'])

      h.db.exec('DELETE FROM block_references')
      await runBackfill()
      expect(refRows(h.db)).toHaveLength(0)
    })
  })

  describe('backfillBlockReferencesSourceFieldIfNeeded marker gate', () => {
    const runMigration = async () => {
      await backfillBlockReferencesSourceFieldIfNeeded({
        execute: async (sql) => h.db.exec(sql),
        getOptional: async <T,>(sql: string) => {
          const row = h.db.prepare(sql).get() as T | undefined
          return row ?? null
        },
      })
    }
    const markerExists = (): boolean =>
      h.db
        .prepare(`SELECT 1 FROM client_schema_state WHERE key = '${BLOCK_REFERENCES_SOURCE_FIELD_MARKER_KEY}'`)
        .get() !== undefined

    it('rebuilds an old block_references table and records the marker', async () => {
      h.insertBlock({
        id: 'src',
        references_json: refsJson([
          {id: 'tgt', alias: 'tgt', sourceField: 'reviewer'},
        ]),
      })
      for (const triggerName of backlinksLocalSchema.triggerNames ?? []) {
        h.db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`)
      }
      h.db.exec('DROP TABLE block_references')
      h.db.exec(`
        CREATE TABLE block_references (
          source_id    TEXT NOT NULL,
          target_id    TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          alias        TEXT NOT NULL,
          PRIMARY KEY (source_id, target_id, alias)
        )
      `)
      h.db
        .prepare('INSERT INTO block_references (source_id, target_id, workspace_id, alias) VALUES (?, ?, ?, ?)')
        .run('old-src', 'old-tgt', 'ws1', 'Old')

      await runMigration()

      expect(markerExists()).toBe(true)
      expect(refRows(h.db)).toEqual([
        {source_id: 'src', target_id: 'tgt', workspace_id: 'ws1', alias: 'tgt', source_field: 'reviewer'},
      ])
      expect(() => h.insertBlock({
        id: 'src2',
        references_json: refsJson([{id: 'tgt', alias: 'tgt', sourceField: 'blocked-by'}]),
      })).not.toThrow()
      expect(refRows(h.db).map(row => row.source_field)).toEqual(['reviewer', 'blocked-by'])
    })

    it('short-circuits once the source-field marker is present', async () => {
      await runMigration()
      h.insertBlock({
        id: 'src',
        references_json: refsJson([{id: 'tgt', alias: 'tgt', sourceField: 'reviewer'}]),
      })
      h.db.exec('DELETE FROM block_references')

      await runMigration()

      expect(refRows(h.db)).toHaveLength(0)
    })
  })
})
