import { describe, expect, it, vi } from 'vitest'
import {
  guardSyncedTableWrites,
  isUnresolvableStatement,
  syncedWriteTarget,
  writeTargetTable,
} from './syncedTableWriteGuard.ts'

describe('writeTargetTable', () => {
  it('extracts the target of INSERT / UPDATE / DELETE (incl. OR-conflict + REPLACE forms)', () => {
    expect(writeTargetTable('UPDATE blocks SET properties_json = ?')).toBe('blocks')
    expect(writeTargetTable('UPDATE OR IGNORE blocks SET x = 1')).toBe('blocks')
    expect(writeTargetTable('INSERT INTO blocks (id) VALUES (?)')).toBe('blocks')
    expect(writeTargetTable('INSERT OR REPLACE INTO workspaces (id) VALUES (?)')).toBe('workspaces')
    expect(writeTargetTable('REPLACE INTO workspace_members (id) VALUES (?)')).toBe('workspace_members')
    expect(writeTargetTable('DELETE FROM blocks WHERE deleted = 1')).toBe('blocks')
  })

  it('tolerates leading whitespace/newlines, comments, and quoted identifiers', () => {
    expect(writeTargetTable('\n  UPDATE "blocks" SET x = 1')).toBe('blocks')
    expect(writeTargetTable('-- migrate\nUPDATE [blocks] SET x = 1')).toBe('blocks')
    expect(writeTargetTable('/* c */ INSERT INTO `blocks` (id) VALUES (?)')).toBe('blocks')
  })

  it('returns null for reads and DDL — including CREATE INDEX/TRIGGER on blocks', () => {
    expect(writeTargetTable('SELECT * FROM blocks WHERE deleted = 0')).toBeNull()
    expect(writeTargetTable('CREATE INDEX IF NOT EXISTS i ON blocks (x) WHERE deleted = 0')).toBeNull()
    expect(writeTargetTable('CREATE TRIGGER t AFTER UPDATE ON blocks BEGIN UPDATE blocks SET x=1; END')).toBeNull()
    expect(writeTargetTable('PRAGMA optimize')).toBeNull()
  })

  it('reads the write target, not tables merely mentioned in FROM/subqueries', () => {
    // The motivating false-positive: a local-index backfill that SELECTs FROM blocks.
    expect(
      writeTargetTable('INSERT OR IGNORE INTO block_aliases (block_id) SELECT id FROM blocks'),
    ).toBe('block_aliases')
  })

  // SQLite accepts a schema prefix on the DML target, and `main.blocks` IS
  // the synced table — an exact-name check on the raw capture missed it.
  it('strips a schema qualifier before matching the table name', () => {
    expect(writeTargetTable('UPDATE main.blocks SET content = ?')).toBe('blocks')
    expect(writeTargetTable('INSERT INTO "main"."blocks" (id) VALUES (?)')).toBe('blocks')
    expect(writeTargetTable('DELETE FROM [main].[workspace_members] WHERE id = ?')).toBe('workspace_members')
    expect(writeTargetTable('UPDATE `main`.`workspaces` SET name = ?')).toBe('workspaces')
    // A dot inside a quoted identifier is part of the NAME, not a qualifier.
    expect(writeTargetTable('UPDATE "a.b" SET x = 1')).toBe('a.b')
    // Local tables stay local however they're qualified.
    expect(writeTargetTable('INSERT INTO main.block_aliases (block_id) VALUES (?)')).toBe('block_aliases')
  })

  // SQLite lets a WITH clause prefix DML, not just SELECT, so a statement whose
  // FIRST token is `WITH` can still be a synced-table write (PR #386 review).
  it('resolves through a leading WITH clause to the real DML target', () => {
    expect(writeTargetTable(
      'WITH ids AS (SELECT id FROM blocks_synced) UPDATE blocks SET content = ?',
    )).toBe('blocks')
    expect(writeTargetTable(
      'WITH RECURSIVE up(id) AS (SELECT ? UNION ALL SELECT b.id FROM blocks b JOIN up ON 1) '
      + 'DELETE FROM blocks WHERE id IN (SELECT id FROM up)',
    )).toBe('blocks')
    expect(writeTargetTable(
      'WITH a AS (SELECT 1), b AS (SELECT 2) INSERT INTO workspaces (id) SELECT 1',
    )).toBe('workspaces')
  })

  it('keeps CTE reads unflagged, including a literal paren inside the CTE body', () => {
    expect(writeTargetTable(
      'WITH RECURSIVE up(id, depth) AS (SELECT id, 0 FROM blocks) SELECT * FROM up',
    )).toBeNull()
    // A `(` inside a string literal would unbalance a naive depth count and
    // hide the write that follows.
    expect(writeTargetTable(
      `WITH x AS (SELECT '(' AS c FROM blocks) UPDATE blocks SET content = ?`,
    )).toBe('blocks')
    // A CTE *named* like a keyword prefix must not be mistaken for the verb.
    expect(writeTargetTable(
      'WITH updates AS (SELECT 1) SELECT * FROM updates',
    )).toBeNull()
  })
})

// `applyLocalSchemaContributions` hands its string straight to `db.execute`
// with no params, and the adapter runs EVERY statement in it — so checking
// only the first left a raw synced write behind a harmless-looking CREATE.
describe('multi-statement scripts', () => {
  it('finds a synced write in any statement, not just the first', () => {
    expect(syncedWriteTarget('CREATE INDEX i ON blocks (x); UPDATE blocks SET content = ?')).toBe('blocks')
    expect(syncedWriteTarget('SELECT 1; DELETE FROM blocks WHERE id = ?')).toBe('blocks')
    expect(syncedWriteTarget('SELECT 1;\n  INSERT INTO workspaces (id) VALUES (?)')).toBe('workspaces')
  })

  it('leaves all-local scripts alone, including semicolons inside literals and trigger bodies', () => {
    expect(syncedWriteTarget('CREATE INDEX a ON blocks (x); CREATE INDEX b ON blocks (y)')).toBeNull()
    expect(syncedWriteTarget(`INSERT INTO block_aliases (x) VALUES (';'); SELECT 1`)).toBeNull()
    // The write verb lives inside a trigger BODY — the fragment it starts is
    // still the CREATE, so nothing matches at a fragment start.
    expect(syncedWriteTarget(
      'CREATE TRIGGER t AFTER UPDATE ON blocks BEGIN UPDATE blocks SET x=1; END',
    )).toBeNull()
  })
})

describe('isUnresolvableStatement', () => {
  it('is true only for a WITH prefix whose statement verb never appears', () => {
    expect(isUnresolvableStatement('WITH ids AS (SELECT 1')).toBe(true)
    expect(isUnresolvableStatement('WITH ids AS (SELECT 1) UPDATE blocks SET x = 1')).toBe(false)
    expect(isUnresolvableStatement('WITH ids AS (SELECT 1) SELECT * FROM ids')).toBe(false)
    expect(isUnresolvableStatement('SELECT * FROM blocks')).toBe(false)
    expect(isUnresolvableStatement('UPDATE blocks SET x = 1')).toBe(false)
  })
})

describe('guardSyncedTableWrites', () => {
  const synced = ['blocks', 'workspaces', 'workspace_members']

  it.each(synced)('throws on a raw write to the synced table %s', async (table) => {
    const inner = vi.fn(async () => undefined)
    const execute = guardSyncedTableWrites(inner)
    await expect(execute(`UPDATE ${table} SET x = 1`)).rejects.toThrow(/synced table/i)
    expect(inner).not.toHaveBeenCalled()
  })

  it('passes through reads, local-derived-table writes, and DDL on blocks', async () => {
    const inner = vi.fn(async () => 'ok')
    const execute = guardSyncedTableWrites(inner)
    // The exact statements the live backfills issue — must not be flagged.
    const allowed = [
      'SELECT id FROM blocks WHERE deleted = 0',
      'INSERT OR IGNORE INTO block_aliases (block_id) SELECT id FROM blocks',
      'INSERT OR IGNORE INTO block_types (block_id) SELECT id FROM blocks',
      'INSERT OR IGNORE INTO blocks_fts_rowids (block_id) SELECT id FROM blocks',
      'INSERT OR IGNORE INTO block_references (source_id) SELECT id FROM blocks',
      'DROP TABLE IF EXISTS block_references',
      'INSERT OR REPLACE INTO client_schema_state (key, completed_at) VALUES (?, ?)',
      'CREATE INDEX IF NOT EXISTS idx_blocks_daily_note_date ON blocks (x) WHERE deleted = 0',
    ]
    for (const sql of allowed) {
      await expect(execute(sql)).resolves.toBe('ok')
    }
    expect(inner).toHaveBeenCalledTimes(allowed.length)
  })

  it('rejects a synced write hiding behind a leading local statement', async () => {
    const inner = vi.fn(async () => 'ok')
    const execute = guardSyncedTableWrites(inner)
    await expect(execute('CREATE INDEX i ON blocks (x); UPDATE blocks SET content = ?'))
      .rejects.toThrow(/synced table "blocks"/)
    expect(inner).not.toHaveBeenCalled()
  })

  it('forwards sql + params unchanged to the wrapped execute', async () => {
    const inner = vi.fn<(sql: string, params?: unknown[]) => Promise<undefined>>(async () => undefined)
    const execute = guardSyncedTableWrites(inner)
    await execute('INSERT OR IGNORE INTO block_aliases (block_id) VALUES (?)', ['b1'])
    expect(inner).toHaveBeenCalledWith('INSERT OR IGNORE INTO block_aliases (block_id) VALUES (?)', ['b1'])
  })
})
