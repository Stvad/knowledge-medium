import type { LocalSchemaContribution, LocalSchemaDb } from '@/data/facets.ts'

export const CREATE_BLOCKS_WORKSPACE_REFERENCES_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_blocks_workspace_with_references
  ON blocks (workspace_id)
  WHERE deleted = 0 AND references_json != '[]'
`

/** Trigger-maintained directed-edge index over `blocks.references_json`,
 *  one row per `(source, target, alias, source_field)` tuple. */
export const CREATE_BLOCK_REFERENCES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS block_references (
    source_id    TEXT NOT NULL,
    target_id    TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    alias        TEXT NOT NULL,
    source_field TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (source_id, target_id, alias, source_field)
  )
`

export const CREATE_BLOCK_REFERENCES_TARGET_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_block_references_target
  ON block_references (target_id, workspace_id)
`

const referencesInsertSelectSql = (rowRef: 'NEW') => `
      INSERT OR IGNORE INTO block_references (source_id, target_id, workspace_id, alias, source_field)
      SELECT
        ${rowRef}.id,
        json_extract(je.value, '$.id'),
        ${rowRef}.workspace_id,
        json_extract(je.value, '$.alias'),
        COALESCE(json_extract(je.value, '$.sourceField'), '')
      FROM json_each(${rowRef}.references_json) AS je
      WHERE typeof(json_extract(je.value, '$.id')) = 'text'
        AND typeof(json_extract(je.value, '$.alias')) = 'text'
        AND (
          json_type(je.value, '$.sourceField') IS NULL
          OR typeof(json_extract(je.value, '$.sourceField')) = 'text'
        );
`.trim()

export const CREATE_BLOCKS_REFERENCES_INSERT_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS blocks_references_insert
  AFTER INSERT ON blocks
  WHEN NEW.deleted = 0
  BEGIN
    ${referencesInsertSelectSql('NEW')}
  END
`

export const CREATE_BLOCKS_REFERENCES_UPDATE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS blocks_references_update
  AFTER UPDATE OF references_json, deleted, workspace_id ON blocks
  BEGIN
    DELETE FROM block_references WHERE source_id = NEW.id;
    INSERT OR IGNORE INTO block_references (source_id, target_id, workspace_id, alias, source_field)
    SELECT
      NEW.id,
      json_extract(je.value, '$.id'),
      NEW.workspace_id,
      json_extract(je.value, '$.alias'),
      COALESCE(json_extract(je.value, '$.sourceField'), '')
    FROM json_each(NEW.references_json) AS je
    WHERE NEW.deleted = 0
      AND typeof(json_extract(je.value, '$.id')) = 'text'
      AND typeof(json_extract(je.value, '$.alias')) = 'text'
      AND (
        json_type(je.value, '$.sourceField') IS NULL
        OR typeof(json_extract(je.value, '$.sourceField')) = 'text'
      );
  END
`

export const CREATE_BLOCKS_REFERENCES_DELETE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS blocks_references_delete
  AFTER DELETE ON blocks
  BEGIN
    DELETE FROM block_references WHERE source_id = OLD.id;
  END
`

export const BLOCK_REFERENCES_BACKFILL_MARKER_KEY = 'block_references_backfill_v1'
export const BLOCK_REFERENCES_SOURCE_FIELD_MARKER_KEY = 'block_references_source_field_v1'

export const SELECT_BLOCK_REFERENCES_BACKFILL_DONE_SQL = `
  SELECT 1 FROM client_schema_state WHERE key = '${BLOCK_REFERENCES_BACKFILL_MARKER_KEY}'
`

export const RECORD_BLOCK_REFERENCES_BACKFILL_DONE_SQL = `
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES ('${BLOCK_REFERENCES_BACKFILL_MARKER_KEY}', strftime('%s', 'now') * 1000)
`

export const SELECT_BLOCK_REFERENCES_SOURCE_FIELD_DONE_SQL = `
  SELECT 1 FROM client_schema_state WHERE key = '${BLOCK_REFERENCES_SOURCE_FIELD_MARKER_KEY}'
`

export const RECORD_BLOCK_REFERENCES_SOURCE_FIELD_DONE_SQL = `
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES ('${BLOCK_REFERENCES_SOURCE_FIELD_MARKER_KEY}', strftime('%s', 'now') * 1000)
`

export const BACKFILL_BLOCK_REFERENCES_SQL = `
  INSERT OR IGNORE INTO block_references (source_id, target_id, workspace_id, alias, source_field)
  SELECT
    b.id,
    json_extract(je.value, '$.id'),
    b.workspace_id,
    json_extract(je.value, '$.alias'),
    COALESCE(json_extract(je.value, '$.sourceField'), '')
  FROM blocks b, json_each(b.references_json) AS je
  WHERE b.deleted = 0
    AND typeof(json_extract(je.value, '$.id')) = 'text'
    AND typeof(json_extract(je.value, '$.alias')) = 'text'
    AND (
      json_type(je.value, '$.sourceField') IS NULL
      OR typeof(json_extract(je.value, '$.sourceField')) = 'text'
    )
`

export const backfillBlockReferencesIfEmpty = async (
  db: LocalSchemaDb,
): Promise<void> => {
  const done = await db.getOptional<{1: number}>(SELECT_BLOCK_REFERENCES_BACKFILL_DONE_SQL)
  if (done !== null) return
  await db.execute(BACKFILL_BLOCK_REFERENCES_SQL)
  await db.execute(RECORD_BLOCK_REFERENCES_BACKFILL_DONE_SQL)
}

export const BLOCK_REFERENCES_TRIGGER_NAMES = [
  'blocks_references_insert',
  'blocks_references_update',
  'blocks_references_delete',
] as const

export const backfillBlockReferencesSourceFieldIfNeeded = async (
  db: LocalSchemaDb,
): Promise<void> => {
  const done = await db.getOptional<{1: number}>(SELECT_BLOCK_REFERENCES_SOURCE_FIELD_DONE_SQL)
  if (done !== null) return

  for (const triggerName of BLOCK_REFERENCES_TRIGGER_NAMES) {
    await db.execute(`DROP TRIGGER IF EXISTS ${triggerName}`)
  }
  await db.execute('DROP TABLE IF EXISTS block_references')
  await db.execute(CREATE_BLOCK_REFERENCES_TABLE_SQL)
  await db.execute(CREATE_BLOCK_REFERENCES_TARGET_INDEX_SQL)
  await db.execute(CREATE_BLOCKS_REFERENCES_INSERT_TRIGGER_SQL)
  await db.execute(CREATE_BLOCKS_REFERENCES_UPDATE_TRIGGER_SQL)
  await db.execute(CREATE_BLOCKS_REFERENCES_DELETE_TRIGGER_SQL)
  await db.execute(BACKFILL_BLOCK_REFERENCES_SQL)
  await db.execute(RECORD_BLOCK_REFERENCES_SOURCE_FIELD_DONE_SQL)
}

export const backlinksLocalSchema: LocalSchemaContribution = {
  id: 'backlinks.local-schema',
  statements: [
    CREATE_BLOCKS_WORKSPACE_REFERENCES_INDEX_SQL,
    CREATE_BLOCK_REFERENCES_TABLE_SQL,
    CREATE_BLOCK_REFERENCES_TARGET_INDEX_SQL,
    CREATE_BLOCKS_REFERENCES_INSERT_TRIGGER_SQL,
    CREATE_BLOCKS_REFERENCES_UPDATE_TRIGGER_SQL,
    CREATE_BLOCKS_REFERENCES_DELETE_TRIGGER_SQL,
  ],
  triggerNames: BLOCK_REFERENCES_TRIGGER_NAMES,
  backfills: [
    {
      id: 'backlinks.block-references-source-field',
      run: backfillBlockReferencesSourceFieldIfNeeded,
    },
    {
      id: 'backlinks.block-references-backfill',
      run: backfillBlockReferencesIfEmpty,
    },
  ],
}
