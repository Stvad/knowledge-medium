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
  CREATE INDEX IF NOT EXISTS idx_block_references_ws_alias
  ON block_references (workspace_id, alias)
`,i=`
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
`,a=`
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
`,o=`
  CREATE TRIGGER IF NOT EXISTS blocks_references_delete
  AFTER DELETE ON blocks
  BEGIN
    DELETE FROM block_references WHERE source_id = OLD.id;
  END
`,s=`block_references_backfill_v1`,c=`block_references_source_field_v1`,l=`
  SELECT 1 FROM client_schema_state WHERE key = '${s}'
`,u=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES ('${s}', strftime('%s', 'now') * 1000)
`,d=`
  SELECT 1 FROM client_schema_state WHERE key = '${c}'
`,f=`
  INSERT OR REPLACE INTO client_schema_state (key, completed_at)
  VALUES ('${c}', strftime('%s', 'now') * 1000)
`,p=`
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
`,m=async e=>{await e.getOptional(l)===null&&(await e.execute(p),await e.execute(u))},h=[`blocks_references_insert`,`blocks_references_update`,`blocks_references_delete`],g=async e=>{if(await e.getOptional(d)===null){for(let t of h)await e.execute(`DROP TRIGGER IF EXISTS ${t}`);await e.execute(`DROP TABLE IF EXISTS block_references`),await e.execute(t),await e.execute(n),await e.execute(r),await e.execute(i),await e.execute(a),await e.execute(o),await e.execute(p),await e.execute(f)}},_={id:`references.local-schema`,statements:[e,t,n,r,i,a,o],triggerNames:h,analyzeTables:[{name:`block_references`,probe:`SELECT target_id FROM block_references WHERE workspace_id = '' AND alias = ''`}],backfills:[{id:`references.block-references-source-field`,run:g},{id:`references.block-references-backfill`,run:m}]};export{p as BACKFILL_BLOCK_REFERENCES_SQL,s as BLOCK_REFERENCES_BACKFILL_MARKER_KEY,c as BLOCK_REFERENCES_SOURCE_FIELD_MARKER_KEY,h as BLOCK_REFERENCES_TRIGGER_NAMES,o as CREATE_BLOCKS_REFERENCES_DELETE_TRIGGER_SQL,i as CREATE_BLOCKS_REFERENCES_INSERT_TRIGGER_SQL,a as CREATE_BLOCKS_REFERENCES_UPDATE_TRIGGER_SQL,e as CREATE_BLOCKS_WORKSPACE_REFERENCES_INDEX_SQL,t as CREATE_BLOCK_REFERENCES_TABLE_SQL,n as CREATE_BLOCK_REFERENCES_TARGET_INDEX_SQL,r as CREATE_BLOCK_REFERENCES_WS_ALIAS_INDEX_SQL,u as RECORD_BLOCK_REFERENCES_BACKFILL_DONE_SQL,f as RECORD_BLOCK_REFERENCES_SOURCE_FIELD_DONE_SQL,l as SELECT_BLOCK_REFERENCES_BACKFILL_DONE_SQL,d as SELECT_BLOCK_REFERENCES_SOURCE_FIELD_DONE_SQL,m as backfillBlockReferencesIfEmpty,g as backfillBlockReferencesSourceFieldIfNeeded,_ as referencesLocalSchema};
//# sourceMappingURL=localSchema.js.map