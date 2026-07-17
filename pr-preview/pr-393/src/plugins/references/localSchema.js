var e=`
  CREATE INDEX IF NOT EXISTS idx_blocks_workspace_with_references
  ON blocks (workspace_id)
  WHERE deleted = 0 AND references_json != '[]'
`,t=`
  CREATE TABLE IF NOT EXISTS block_references (
    source_id    TEXT NOT NULL,
    target_id    TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    alias        TEXT NOT NULL,
    source_field TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (source_id, target_id, alias, source_field)
  )
`,n=`
  CREATE INDEX IF NOT EXISTS idx_block_references_target
  ON block_references (target_id, workspace_id)
`,r=`
  CREATE TRIGGER IF NOT EXISTS blocks_references_insert
  AFTER INSERT ON blocks
  WHEN NEW.deleted = 0
  BEGIN
    ${(e=>`
      INSERT OR IGNORE INTO block_references (source_id, target_id, workspace_id, alias, source_field)
      SELECT
        ${e}.id,
        json_extract(je.value, '$.id'),
        ${e}.workspace_id,
        json_extract(je.value, '$.alias'),
        COALESCE(json_extract(je.value, '$.sourceField'), '')
      FROM json_each(${e}.references_json) AS je
      WHERE typeof(json_extract(je.value, '$.id')) = 'text'
        AND typeof(json_extract(je.value, '$.alias')) = 'text'
        AND (
          json_type(je.value, '$.sourceField') IS NULL
          OR typeof(json_extract(je.value, '$.sourceField')) = 'text'
        );
`.trim())(`NEW`)}
  END
`,i=`
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
`,a=`
  CREATE TRIGGER IF NOT EXISTS blocks_references_delete
  AFTER DELETE ON blocks
  BEGIN
    DELETE FROM block_references WHERE source_id = OLD.id;
  END
`,o=`block_references_backfill_v1`,s=`block_references_source_field_v1`,c=`
  SELECT 1 FROM client_schema_state WHERE key = '${o}'
`,l=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES ('${o}', strftime('%s', 'now') * 1000)
`,u=`
  SELECT 1 FROM client_schema_state WHERE key = '${s}'
`,d=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES ('${s}', strftime('%s', 'now') * 1000)
`,f=`
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
`,p=async e=>{await e.getOptional(c)===null&&(await e.execute(f),await e.execute(l))},m=[`blocks_references_insert`,`blocks_references_update`,`blocks_references_delete`],h=async e=>{if(await e.getOptional(u)===null){for(let t of m)await e.execute(`DROP TRIGGER IF EXISTS ${t}`);await e.execute(`DROP TABLE IF EXISTS block_references`),await e.execute(t),await e.execute(n),await e.execute(r),await e.execute(i),await e.execute(a),await e.execute(f),await e.execute(d)}},g={id:`references.local-schema`,statements:[e,t,n,r,i,a],triggerNames:m,backfills:[{id:`references.block-references-source-field`,run:h},{id:`references.block-references-backfill`,run:p}]};export{f as BACKFILL_BLOCK_REFERENCES_SQL,o as BLOCK_REFERENCES_BACKFILL_MARKER_KEY,s as BLOCK_REFERENCES_SOURCE_FIELD_MARKER_KEY,m as BLOCK_REFERENCES_TRIGGER_NAMES,a as CREATE_BLOCKS_REFERENCES_DELETE_TRIGGER_SQL,r as CREATE_BLOCKS_REFERENCES_INSERT_TRIGGER_SQL,i as CREATE_BLOCKS_REFERENCES_UPDATE_TRIGGER_SQL,e as CREATE_BLOCKS_WORKSPACE_REFERENCES_INDEX_SQL,t as CREATE_BLOCK_REFERENCES_TABLE_SQL,n as CREATE_BLOCK_REFERENCES_TARGET_INDEX_SQL,l as RECORD_BLOCK_REFERENCES_BACKFILL_DONE_SQL,d as RECORD_BLOCK_REFERENCES_SOURCE_FIELD_DONE_SQL,c as SELECT_BLOCK_REFERENCES_BACKFILL_DONE_SQL,u as SELECT_BLOCK_REFERENCES_SOURCE_FIELD_DONE_SQL,p as backfillBlockReferencesIfEmpty,h as backfillBlockReferencesSourceFieldIfNeeded,g as referencesLocalSchema};
//# sourceMappingURL=localSchema.js.map