import { describe, expect, it, vi } from 'vitest'
import {
  guardSyncedTableWrites,
  syncedWriteTarget,
  writeTargets,
} from './syncedTableWriteGuard.ts'
import {
  BACKFILL_BLOCK_REFERENCES_SQL,
  CREATE_BLOCKS_REFERENCES_DELETE_TRIGGER_SQL,
  CREATE_BLOCKS_REFERENCES_INSERT_TRIGGER_SQL,
  CREATE_BLOCKS_REFERENCES_UPDATE_TRIGGER_SQL,
  CREATE_BLOCKS_WORKSPACE_REFERENCES_INDEX_SQL,
  CREATE_BLOCK_REFERENCES_TABLE_SQL,
  CREATE_BLOCK_REFERENCES_TARGET_INDEX_SQL,
} from '@/plugins/references/localSchema.ts'
import { CLIENT_SCHEMA_STATEMENTS } from '@/data/internals/clientSchema.ts'
import { dailyNotesLocalSchema } from '@/plugins/daily-notes/localSchema.ts'

describe('writeTargets / syncedWriteTarget', () => {
  const target = (sql: string) => writeTargets(sql)[0] ?? null

  it('extracts the target of INSERT / UPDATE / DELETE (incl. OR-conflict + REPLACE forms)', () => {
    expect(target('UPDATE blocks SET properties_json = ?')).toBe('blocks')
    expect(target('UPDATE OR IGNORE blocks SET x = 1')).toBe('blocks')
    expect(target('INSERT INTO blocks (id) VALUES (?)')).toBe('blocks')
    expect(target('INSERT OR REPLACE INTO workspaces (id) VALUES (?)')).toBe('workspaces')
    expect(target('REPLACE INTO workspace_members (id) VALUES (?)')).toBe('workspace_members')
    expect(target('DELETE FROM blocks WHERE deleted = 1')).toBe('blocks')
  })

  it('tolerates whitespace, comments, and quoted identifiers', () => {
    expect(target('\n  UPDATE "blocks" SET x = 1')).toBe('blocks')
    expect(target('-- migrate\nUPDATE [blocks] SET x = 1')).toBe('blocks')
    expect(target('/* c */ INSERT INTO `blocks` (id) VALUES (?)')).toBe('blocks')
  })

  // Comments are whitespace to SQLite, so they can sit BETWEEN the keywords —
  // a pattern joined by `\s+` missed these entirely.
  it('sees through comments between the DML keywords', () => {
    expect(syncedWriteTarget('UPDATE /* note */ blocks SET x = 1')).toBe('blocks')
    expect(syncedWriteTarget('INSERT /* note */ INTO blocks (id) VALUES (?)')).toBe('blocks')
    expect(syncedWriteTarget('DELETE /* note */ FROM blocks WHERE id = ?')).toBe('blocks')
    expect(syncedWriteTarget('UPDATE -- note\n blocks SET x = 1')).toBe('blocks')
  })

  it('returns null for reads and DDL that only MENTION a synced table', () => {
    expect(syncedWriteTarget('SELECT * FROM blocks WHERE deleted = 0')).toBeNull()
    expect(syncedWriteTarget('CREATE INDEX IF NOT EXISTS i ON blocks (x) WHERE deleted = 0')).toBeNull()
    expect(syncedWriteTarget('PRAGMA optimize')).toBeNull()
    // Trigger HEADERS name the table after the event, not after a DML verb.
    expect(syncedWriteTarget('CREATE TRIGGER t AFTER UPDATE ON blocks BEGIN DELETE FROM block_refs; END')).toBeNull()
    expect(syncedWriteTarget('CREATE TRIGGER t AFTER UPDATE OF x ON blocks BEGIN SELECT 1; END')).toBeNull()
    expect(syncedWriteTarget('CREATE TRIGGER t AFTER INSERT ON blocks BEGIN SELECT 1; END')).toBeNull()
    expect(syncedWriteTarget('CREATE TRIGGER t AFTER DELETE ON blocks BEGIN SELECT 1; END')).toBeNull()
  })

  // DESTRUCTIVE DDL (PR #386 review). The guard exists so a raw path can't
  // quietly desync the local store; `DROP TABLE blocks` does that far more
  // thoroughly than any UPDATE, and the DML-only scan let it through. The line
  // is drawn at destructive shapes — DROP TABLE, and the ALTER forms that
  // remove or rename existing structure — NOT at DDL in general.
  it('rejects destructive DDL against a synced table', () => {
    expect(syncedWriteTarget('DROP TABLE blocks')).toBe('blocks')
    expect(syncedWriteTarget('DROP TABLE IF EXISTS workspaces')).toBe('workspaces')
    expect(syncedWriteTarget('ALTER TABLE workspaces RENAME TO ws_old')).toBe('workspaces')
    expect(syncedWriteTarget('ALTER TABLE blocks RENAME COLUMN content TO body')).toBe('blocks')
    expect(syncedWriteTarget('ALTER TABLE blocks DROP COLUMN content')).toBe('blocks')
    expect(syncedWriteTarget("DROP TABLE 'blocks'")).toBe('blocks')
    expect(syncedWriteTarget('DROP TABLE main . blocks')).toBe('blocks')
  })

  // The counterweight, and the reason a blanket DDL rejection would be wrong:
  // the bootstrap adds local columns to BOTH synced tables by ALTER (see
  // blockSchema.ts / workspaceSchema.ts) and hangs its triggers off `blocks`.
  // Those run through the guarded handle, so over-matching here bricks boot.
  it('allows additive DDL and trigger maintenance on a synced table', () => {
    expect(syncedWriteTarget('ALTER TABLE blocks ADD COLUMN reference_target_id TEXT')).toBeNull()
    expect(syncedWriteTarget("ALTER TABLE workspaces ADD COLUMN properties_migration TEXT")).toBeNull()
    expect(syncedWriteTarget('DROP TRIGGER IF EXISTS blocks_upload_insert')).toBeNull()
    expect(syncedWriteTarget('DROP INDEX IF EXISTS idx_blocks_parent')).toBeNull()
  })

  it('reads the write target, not tables merely mentioned in FROM/subqueries', () => {
    // The motivating false-positive: a local-index backfill that SELECTs FROM blocks.
    expect(syncedWriteTarget('INSERT OR IGNORE INTO block_aliases (block_id) SELECT id FROM blocks')).toBeNull()
  })

  // SQLite tolerates whitespace around the qualifier dot; a capture that
  // stopped at the first space saw only `main`.
  it('handles whitespace around the qualifier dot', () => {
    expect(syncedWriteTarget('UPDATE main . blocks SET x = 1')).toBe('blocks')
    expect(syncedWriteTarget('INSERT INTO "main" . "blocks" (id) VALUES (?)')).toBe('blocks')
    expect(syncedWriteTarget('DELETE FROM main\n  .\n  blocks WHERE id = ?')).toBe('blocks')
    expect(syncedWriteTarget('UPDATE main . block_aliases SET x = 1')).toBeNull()
  })

  it('strips a schema qualifier before matching the table name', () => {
    expect(syncedWriteTarget('UPDATE main.blocks SET content = ?')).toBe('blocks')
    expect(syncedWriteTarget('INSERT INTO "main"."blocks" (id) VALUES (?)')).toBe('blocks')
    expect(syncedWriteTarget('DELETE FROM [main].[workspace_members] WHERE id = ?')).toBe('workspace_members')
    expect(syncedWriteTarget('UPDATE `main`.`workspaces` SET name = ?')).toBe('workspaces')
    expect(target('UPDATE "a.b" SET x = 1')).toBe('a.b')
    expect(syncedWriteTarget('INSERT INTO main.block_aliases (block_id) VALUES (?)')).toBeNull()
  })

  // Position no longer matters: a CTE prefix, a later statement, or a trigger
  // BODY all put the write somewhere a leading-verb check couldn't see.
  it('finds a synced write wherever it sits — CTE prefix, later statement, trigger body', () => {
    expect(syncedWriteTarget('WITH ids AS (SELECT id FROM blocks_synced) UPDATE blocks SET content = ?')).toBe('blocks')
    expect(syncedWriteTarget('CREATE INDEX i ON blocks (x); UPDATE blocks SET content = ?')).toBe('blocks')
    expect(syncedWriteTarget('SELECT 1; DELETE FROM blocks WHERE id = ?')).toBe('blocks')
    // A trigger that writes a synced table WILL fire outside any repo.tx.
    expect(syncedWriteTarget(
      'CREATE TRIGGER t AFTER INSERT ON local_table BEGIN UPDATE blocks SET x = 1; END',
    )).toBe('blocks')
    expect(syncedWriteTarget(
      'CREATE TRIGGER t AFTER INSERT ON local_table BEGIN DELETE FROM workspaces WHERE id = 1; END',
    )).toBe('workspaces')
  })

  // SQLite accepts a single-quoted table name in DML position — verified
  // against the engine. The main scan blanks string literals (so prose can't
  // fake a write), which is exactly what hid this spelling.
  it('catches a single-quoted table identifier without letting prose through', () => {
    expect(syncedWriteTarget(`UPDATE 'blocks' SET content = ?`)).toBe('blocks')
    expect(syncedWriteTarget(`DELETE FROM 'blocks' WHERE id = ?`)).toBe('blocks')
    expect(syncedWriteTarget(`INSERT INTO 'workspaces' (id) VALUES (?)`)).toBe('workspaces')
    expect(syncedWriteTarget(`UPDATE 'main'.'blocks' SET x = 1`)).toBe('blocks')
    expect(syncedWriteTarget(`UPDATE main . 'blocks' SET x = 1`)).toBe('blocks')
    // Prose that merely READS like DML stays clean — the name isn't quoted.
    expect(syncedWriteTarget(`INSERT INTO block_aliases (note) VALUES ('update blocks now')`)).toBeNull()
    expect(syncedWriteTarget(`INSERT INTO block_aliases (note) VALUES ('delete from blocks')`)).toBeNull()
    expect(syncedWriteTarget(`UPDATE 'block_aliases' SET x = 1`)).toBeNull()
  })

  it('keeps prose in string literals from faking a write', () => {
    expect(syncedWriteTarget(`INSERT INTO block_aliases (note) VALUES ('update blocks now')`)).toBeNull()
    expect(syncedWriteTarget(`INSERT INTO block_aliases (x) VALUES (';'); SELECT 1`)).toBeNull()
  })

  // Every schema statement the app ships must read as "no synced write" — a
  // false positive here refuses real local-schema work rather than a lint nit.
  // Iterates the actual collections rather than a hand-copied subset: the
  // first version of this test listed 7 constants from ONE plugin while
  // claiming to cover everything (PR #386 areview), so the 65 kernel trigger
  // and index statements — the ones most likely to trip a DDL pattern, since
  // they all name `blocks` — went unchecked by the test that existed to check
  // them.
  it('passes every real local-schema statement the app ships', () => {
    const shipped = [
      ...CLIENT_SCHEMA_STATEMENTS,
      ...(dailyNotesLocalSchema.statements ?? []),
      CREATE_BLOCK_REFERENCES_TABLE_SQL,
      CREATE_BLOCK_REFERENCES_TARGET_INDEX_SQL,
      CREATE_BLOCKS_WORKSPACE_REFERENCES_INDEX_SQL,
      CREATE_BLOCKS_REFERENCES_INSERT_TRIGGER_SQL,
      CREATE_BLOCKS_REFERENCES_UPDATE_TRIGGER_SQL,
      CREATE_BLOCKS_REFERENCES_DELETE_TRIGGER_SQL,
      BACKFILL_BLOCK_REFERENCES_SQL,
    ]
    // Guard against the collections silently becoming empty imports.
    expect(shipped.length).toBeGreaterThan(50)
    for (const sql of shipped) {
      expect({sql, target: syncedWriteTarget(sql)}).toEqual({sql, target: null})
    }
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
