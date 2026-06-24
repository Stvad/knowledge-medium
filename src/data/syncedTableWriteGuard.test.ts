import { describe, expect, it, vi } from 'vitest'
import { guardSyncedTableWrites, writeTargetTable } from './syncedTableWriteGuard.ts'

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

  it('forwards sql + params unchanged to the wrapped execute', async () => {
    const inner = vi.fn<(sql: string, params?: unknown[]) => Promise<undefined>>(async () => undefined)
    const execute = guardSyncedTableWrites(inner)
    await execute('INSERT OR IGNORE INTO block_aliases (block_id) VALUES (?)', ['b1'])
    expect(inner).toHaveBeenCalledWith('INSERT OR IGNORE INTO block_aliases (block_id) VALUES (?)', ['b1'])
  })
})
